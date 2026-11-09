import type { ChatPostEphemeralArguments } from '@slack/web-api';
import slackifyMarkdown from 'slackify-markdown';
import { MERGE_REQUEST_OPEN_STATES } from '@/constants';
import { logger } from '@/core/services/logger';
import { getProvider } from '@/core/services/providers/ProviderFactory';
import { getPermalink } from '@/core/services/slack';
import type { DataReview } from '@/core/typings/Data';
import type { ProviderType } from '@/core/typings/Provider';
import type { UnifiedPullRequest } from '@/core/typings/UnifiedModels';

interface BuildReviewListEphemeralData {
  channelId: string;
  reviews: DataReview[];
  userId: string;
}

interface ReviewListItem {
  link: string;
  mergeRequest: UnifiedPullRequest;
  projectId: number;
}

interface ReviewListSection {
  items: ReviewListItem[];
  title: string;
}

export async function buildReviewListEphemeral({
  channelId,
  reviews,
  userId,
}: BuildReviewListEphemeralData): Promise<ChatPostEphemeralArguments> {
  const items = await fetchOpenedReviewItems(channelId, reviews);
  const usernames = await findGitUsernames(
    userId,
    new Set(items.map(({ mergeRequest }) => mergeRequest.provider)),
  );

  const sections =
    usernames.size === 0
      ? [{ title: 'Ongoing reviews', items }]
      : await buildPersonalizedSections(items, usernames);

  const nonEmptySections = sections
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      ...section,
      items: [...section.items].sort((a, b) =>
        formatItem(a).localeCompare(formatItem(b)),
      ),
    }));

  const formattedReviews = nonEmptySections
    .map(
      ({ title, items: sectionItems }) =>
        `**${title}:**\n${sectionItems.map(formatItem).join('\n')}`,
    )
    .join('\n\n');

  const formattedReviewsFallback = nonEmptySections
    .flatMap((section) => section.items)
    .map(({ mergeRequest }) => mergeRequest.title)
    .join(', ');

  return {
    channel: channelId,
    user: userId,
    text:
      items.length > 0
        ? `Ongoing reviews: ${formattedReviewsFallback}.`
        : 'There is no ongoing review shared in this channel.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            items.length > 0
              ? slackifyMarkdown(formattedReviews)
              : 'There is no ongoing review shared in this channel :homer-metal:',
        },
      },
    ],
  };
}

async function fetchOpenedReviewItems(
  channelId: string,
  reviews: DataReview[],
): Promise<ReviewListItem[]> {
  const items = await Promise.all(
    reviews.map(async ({ projectId, provider, mergeRequestIid, ts }) => {
      // One provider failing must not hide the reviews of the others.
      const mergeRequest = await getProvider(provider)
        .fetchPullRequest(projectId, mergeRequestIid)
        .catch((error: unknown) => {
          logger.warn(
            { error, projectId, provider, mergeRequestIid },
            'Could not fetch a reviewed pull request',
          );
          return undefined;
        });

      if (mergeRequest === undefined) {
        return undefined;
      }

      if (!MERGE_REQUEST_OPEN_STATES.includes(mergeRequest.state)) {
        return undefined;
      }
      return {
        link: await getPermalink(channelId, ts),
        mergeRequest,
        projectId,
      };
    }),
  );

  return items.filter((item): item is ReviewListItem => item !== undefined);
}

/** Git username of the Slack user on each provider of the listed reviews. */
async function findGitUsernames(
  slackUserId: string,
  providers: Set<ProviderType>,
): Promise<Map<ProviderType, string>> {
  const usernames = new Map<ProviderType, string>();

  await Promise.all(
    [...providers].map(async (provider) => {
      const username = await getProvider(provider)
        .findGitUsername(slackUserId)
        .catch((error: unknown) => {
          logger.warn({ error, provider }, 'Could not find the git username');
          return undefined;
        });
      if (username !== undefined) {
        usernames.set(provider, username);
      }
    }),
  );
  return usernames;
}

/**
 * Splits reviews into:
 *  - those the user is a reviewer of and has not reviewed yet,
 *  - those the user authored,
 *  - the others.
 */
async function buildPersonalizedSections(
  items: ReviewListItem[],
  usernames: Map<ProviderType, string>,
): Promise<ReviewListSection[]> {
  const waitingForReview: ReviewListItem[] = [];
  const authored: ReviewListItem[] = [];
  const others: ReviewListItem[] = [];

  await Promise.all(
    items.map(async (item) => {
      const { projectId } = item;
      const { author, iid, provider } = item.mergeRequest;
      const username = usernames.get(provider);

      if (username !== undefined && isSameUser(author.username, username)) {
        authored.push(item);
        return;
      }

      const isWaitingForReview =
        username !== undefined &&
        (
          await getProvider(provider).fetchPendingReviewerUsernames(
            projectId,
            iid,
          )
        ).some((reviewer) => isSameUser(reviewer, username));

      (isWaitingForReview ? waitingForReview : others).push(item);
    }),
  );

  return [
    { title: 'Waiting for your review', items: waitingForReview },
    { title: 'Your merge requests', items: authored },
    { title: 'Other reviews', items: others },
  ];
}

// GitHub logins are case insensitive.
function isSameUser(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function formatItem({ link, mergeRequest }: ReviewListItem): string {
  return `- [${mergeRequest.title}](${link})`;
}
