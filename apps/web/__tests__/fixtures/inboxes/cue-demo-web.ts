import type {
  ExaEmulatorOptions,
  ExaEmulatorPage,
} from "@/__tests__/emulators/exa";

// The public web as Cue's local demo sees it, for the Exa emulator: the event
// page the Handshake email links to, the SFO page that answers Mom's terminal
// question, and recent news about the companies on David's calendar. News
// items are fictional demo content on reserved example domains.

export const CUE_DEMO_HANDSHAKE_EVENT_URL =
  "https://app.joinhandshake.com/events/1428571";

const SFO_AIRLINES_PAGE: ExaEmulatorPage = {
  url: "https://www.flysfo.com/flights/airlines",
  title: "Airlines at SFO",
  text: "Airlines and terminals at San Francisco International Airport.\n\nUnited Airlines operates from Terminal 3 at SFO. Short-term parking for Terminal 3 is in the Domestic Garage, across from the terminal.\n\nAlaska Airlines operates from Terminal 2. Check your airline before you go.",
};

export function buildCueDemoWebData(
  now = new Date(),
): Required<Pick<ExaEmulatorOptions, "pages" | "searches">> {
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 86_400_000).toISOString();

  return {
    pages: [
      {
        url: CUE_DEMO_HANDSHAKE_EVENT_URL,
        title: "Tech & Finance Career Series | Handshake",
        text: "Tech & Finance Career Series\nHosted by UC San Diego Career Center\n\nTuesday, 6:00 PM to 8:00 PM\nPrice Center Ballroom West, UC San Diego\n\nMeet recruiters and recent alumni from software, trading and banking firms. Bring copies of your resume; business casual attire recommended. Open to all majors.",
      },
      SFO_AIRLINES_PAGE,
    ],
    searches: [
      {
        match: /acme/i,
        results: [
          {
            url: "https://news.example.com/2026/acme-corp-security-chief",
            title: "Acme Corp names a new chief security officer (demo)",
            text: "Fictional demo article. Acme Corp named a new chief security officer and said it will review the security of every vendor up for renewal this quarter.",
            publishedDate: daysAgo(2),
          },
          {
            url: "https://business.example.org/acme-corp-budget-2027",
            title: "Acme Corp tightens software budgets for 2027 (demo)",
            text: "Fictional demo article. Acme Corp told investors it will favor multi-year software contracts with predictable pricing as it trims 2027 spending.",
            publishedDate: daysAgo(5),
          },
        ],
      },
      {
        match: /nvidia/i,
        results: [
          {
            url: "https://news.example.com/2026/nvidia-new-grad-hiring",
            title: "NVIDIA expands new-grad engineering hiring (demo)",
            text: "Fictional demo article. NVIDIA said it will grow its new-college-grad software engineering classes next year, with most roles in Santa Clara.",
            publishedDate: daysAgo(1),
          },
          {
            url: "https://business.example.org/nvidia-campus-webinars",
            title: "NVIDIA launches campus webinar series (demo)",
            text: "Fictional demo article. NVIDIA's university recruiting team is hosting weekly webinars for students interviewing for new-grad roles.",
            publishedDate: daysAgo(4),
          },
        ],
      },
      { match: /terminal|sfo|united/i, results: [SFO_AIRLINES_PAGE] },
    ],
  };
}

/**
 * What a model would answer for Mom's question once a web search found the
 * SFO page: the day and time from the trip confirmation (c1), the terminal
 * from the page. The page's source id depends on how many related items come
 * before it, so local dev registers this once per possible id.
 */
export const cueDemoWebReply = {
  subject: "Thanksgiving flight?",
  page: SFO_AIRLINES_PAGE,
  object: (pageSourceId: string) => ({
    enoughEvidence: true,
    missing: "",
    reply:
      "Hi Mom! I fly home Wednesday, November 25 on UA 2231, landing at SFO at 6:35 PM. United uses Terminal 3, and Dad can park in the Domestic Garage right across from it. Thanks for picking me up!",
    claims: [
      {
        fact: "The flight home is Wednesday, November 25, UA 2231",
        sourceId: "c1",
        quote: "Departing Wednesday, November 25: flight UA 2231",
      },
      {
        fact: "It lands at SFO at 6:35 PM",
        sourceId: "c1",
        quote: "SAN 5:05 PM to SFO 6:35 PM",
      },
      {
        fact: "United uses Terminal 3 at SFO",
        sourceId: pageSourceId,
        quote: "United Airlines operates from Terminal 3 at SFO",
      },
      {
        fact: "Terminal 3 parking is in the Domestic Garage, across from it",
        sourceId: pageSourceId,
        quote:
          "Short-term parking for Terminal 3 is in the Domestic Garage, across from the terminal",
      },
    ],
  }),
};
