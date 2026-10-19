const MAX_SHOWN_COUNT = 99;

export function formatUnreadTitle(count: number, brandName: string) {
  if (count <= 0) return null;
  const shown = count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : count;
  return `Inbox (${shown}) – ${brandName}`;
}

/**
 * Next sets the title on every navigation, so the count is re-applied when the
 * app writes a new page title, and the latest page title is what comes back
 * when nothing is unread.
 */
export function keepUnreadTitle(brandName: string) {
  let count = 0;
  let pageTitle = document.title;
  let applied: string | null = null;

  const apply = () => {
    applied = formatUnreadTitle(count, brandName);
    document.title = applied ?? pageTitle;
  };

  const observer = new MutationObserver(() => {
    if (document.title === applied) return;
    pageTitle = document.title;
    if (applied) apply();
  });
  observer.observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  return {
    set(next: number) {
      if (next === count) return;
      count = next;
      if (document.title !== applied) pageTitle = document.title;
      apply();
    },
    dispose() {
      observer.disconnect();
      count = 0;
      document.title = pageTitle;
    },
  };
}
