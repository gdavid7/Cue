"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import type { TeamConversationResponse } from "@/app/api/team-comments/conversations/[conversationId]/route";
import type { TeamCommentsResponse } from "@/app/api/team-comments/conversations/[conversationId]/comments/route";

export function useConversationDiscussion(
  memberId: string,
  conversationId: string,
) {
  const [revoked, setRevoked] = useState(false);
  // While the stream is live it reports changes and revocation itself, so
  // the summary and comments are not also polled.
  const [streamLive, setStreamLive] = useState(false);
  const refreshInterval = streamLive ? 0 : 30_000;
  const query = `memberId=${encodeURIComponent(memberId)}`;
  const summary = useSWR<TeamConversationResponse>(
    `/api/team-comments/conversations/${conversationId}?${query}`,
    // Access can be granted again after a revocation, so any successful
    // summary load means the member can read the conversation.
    { refreshInterval, onSuccess: () => setRevoked(false) },
  );
  const generation = summary.data?.generation;
  const commentPages = useSWRInfinite<TeamCommentsResponse>(
    (index, previousPage) => {
      if (!generation || (index > 0 && !previousPage?.nextCursor)) return null;
      const beforeRevision = index > 0 ? previousPage?.nextCursor : undefined;
      return `/api/team-comments/conversations/${conversationId}/comments?${query}&generation=${generation}&limit=100${beforeRevision ? `&beforeRevision=${beforeRevision}` : ""}`;
    },
    { refreshInterval },
  );
  const comments = {
    ...commentPages,
    data: commentPages.data
      ? {
          comments: commentPages.data
            .toReversed()
            .flatMap((page) => page.comments),
          nextCursor: commentPages.data.at(-1)?.nextCursor ?? null,
          revision: commentPages.data[0]?.revision,
        }
      : undefined,
  };

  useEffect(() => {
    if (!generation) return;
    const url = `/api/team-comments/stream?conversationId=${encodeURIComponent(conversationId)}&${query}`;
    let stream: EventSource | null = null;
    let ended = false;
    const refresh = () => {
      summary.mutate();
      commentPages.mutate();
    };
    const closeStream = () => {
      stream?.close();
      stream = null;
      setStreamLive(false);
    };
    // Each open stream holds a server function and checks access every 25
    // seconds, so a hidden tab lets it go and catches up when shown.
    const openStream = () => {
      if (stream || ended || document.visibilityState === "hidden") return;
      const opened = new EventSource(url);
      stream = opened;
      let connectedBefore = false;
      opened.addEventListener("ready", () => {
        if (stream !== opened) return;
        setStreamLive(true);
        // Changes during a reconnect are not replayed; polling was off.
        if (connectedBefore) refresh();
        connectedBefore = true;
      });
      opened.addEventListener("error", () => {
        if (stream === opened) setStreamLive(false);
      });
      opened.addEventListener("change", refresh);
      opened.addEventListener("revoked", () => {
        ended = true;
        setRevoked(true);
        summary.mutate(undefined, { revalidate: false });
        commentPages.mutate(undefined, { revalidate: false });
        closeStream();
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        closeStream();
        return;
      }
      openStream();
      refresh();
    };
    const onFocus = () => refresh();
    openStream();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      ended = true;
      closeStream();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [conversationId, generation, query, summary.mutate, commentPages.mutate]);

  return {
    summary,
    comments,
    loadMoreComments: () => commentPages.setSize(commentPages.size + 1),
    revoked,
    refresh: () => {
      summary.mutate();
      commentPages.mutate();
    },
  };
}
