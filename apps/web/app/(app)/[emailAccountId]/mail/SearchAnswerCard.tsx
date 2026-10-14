"use client";

import Link from "next/link";
import useSWR from "swr";
import type { GetSearchAnswerResponse } from "@/app/api/user/search-answer/route";
import { Button } from "@/components/ui/button";
import { prefixPath } from "@/utils/path";
import { getAccountScopedKey } from "@/utils/swr";

/** Answer a committed search that reads as a question, above the results. */
export const SEARCH_ANSWERS = true;

/**
 * What the user's mail says in answer to a search, when it reads as a
 * question and the mail answers it. A plain search, no answer, or a failure
 * leave just the results, or, when there are none, a way to ask in chat.
 */
export function SearchAnswerCard({
  emailAccountId,
  query,
  noResults,
  onContinueInChat,
}: {
  emailAccountId: string;
  /** The search as committed with Enter, never the text being typed. */
  query: string;
  /** The search found no mail. */
  noResults: boolean;
  onContinueInChat: (question: string) => void;
}) {
  const { data, isLoading, error } = useSearchAnswer(emailAccountId, query);

  // "Nothing matched" is known at once; the answer may take seconds, so it
  // loads above the message rather than hiding it.
  const noMatches = noResults ? (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <p className="text-muted-foreground text-sm" role="status">
        No emails match “{query}”.
      </p>
      <Button
        onClick={() => onContinueInChat(query)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Ask Cue in chat →
      </Button>
    </div>
  ) : null;

  if (isLoading) {
    return (
      <>
        <div className="border-border border-b px-4 py-3" role="status">
          <p className="text-muted-foreground text-sm">Reading your mail…</p>
        </div>
        {noMatches}
      </>
    );
  }
  if (error || !data) return noMatches;

  return (
    <section
      aria-label="Answer from your mail"
      className="fade-in animate-in border-border border-b px-4 py-3 duration-150"
    >
      <p className="text-foreground text-sm leading-6">{data.answer}</p>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {data.sources.map((source) => {
          const href =
            source.kind === "email"
              ? prefixPath(
                  emailAccountId,
                  `/mail?thread-id=${encodeURIComponent(source.id)}&thread-account-id=${emailAccountId}`,
                )
              : source.url;
          const className = "text-muted-foreground text-xs";
          return (
            <li key={source.id}>
              {href ? (
                <Link
                  className={`${className} underline-offset-2 hover:text-foreground hover:underline`}
                  href={href}
                  {...(source.kind === "email"
                    ? {}
                    : { rel: "noreferrer", target: "_blank" })}
                >
                  {source.title}
                </Link>
              ) : (
                <span className={className}>{source.title}</span>
              )}
            </li>
          );
        })}
      </ul>
      <Button
        className="-ml-2 mt-1"
        onClick={() => onContinueInChat(query)}
        size="xs-2"
        type="button"
        variant="ghostMuted"
      >
        Continue in chat →
      </Button>
    </section>
  );
}

/** The answer to a committed search, shared by the card and the list under it. */
export function useSearchAnswer(emailAccountId: string, query: string | null) {
  return useSWR<GetSearchAnswerResponse>(
    SEARCH_ANSWERS && query
      ? getAccountScopedKey(
          `/api/user/search-answer?q=${encodeURIComponent(query)}`,
          emailAccountId,
        )
      : null,
    { revalidateOnFocus: false },
  );
}
