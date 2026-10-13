"use client";

import useSWR from "swr";
import { Button } from "@/components/ui/button";

/**
 * Answer a committed search that reads as a question, above the results.
 * Off until its read-only answer step is approved.
 */
export const SEARCH_ANSWERS = false;

type SearchAnswer = {
  answer: string;
  sources: { id: string; title: string; href: string }[];
};

/**
 * What the user's mail says in answer to a search, when it reads as a
 * question and the mail answers it. Nothing otherwise: a plain search, no
 * answer, or a failure all leave just the results.
 */
export function SearchAnswerCard({
  emailAccountId,
  query,
  onContinueInChat,
}: {
  emailAccountId: string;
  /** The search as committed with Enter, never the text being typed. */
  query: string;
  onContinueInChat: (question: string) => void;
}) {
  const { data, isLoading, error } = useSWR(
    SEARCH_ANSWERS && query ? ["search-answer", emailAccountId, query] : null,
    () => fetchAnswer({ emailAccountId, query }),
    { revalidateOnFocus: false },
  );

  if (isLoading) {
    return (
      <div className="border-border border-b px-4 py-3" role="status">
        <p className="text-muted-foreground text-sm">Reading your mail…</p>
      </div>
    );
  }
  if (error || !data) return null;

  return (
    <section
      aria-label="Answer from your mail"
      className="fade-in animate-in border-border border-b px-4 py-3 duration-150"
    >
      <p className="text-foreground text-sm leading-6">{data.answer}</p>
      {data.sources.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {data.sources.map((source) => (
            <li key={source.id}>
              <a
                className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
                href={source.href}
              >
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
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

// No backend yet: the answer step is pending approval.
async function fetchAnswer(_input: {
  emailAccountId: string;
  query: string;
}): Promise<SearchAnswer | null> {
  return null;
}
