import { getEmail } from "@/__tests__/helpers";
import type { EmailForLLM } from "@/utils/types";

// Synthetic inbound mail for the Conversations-versus-automated boundary.
// All people, companies and addresses are invented; none of it is user mail.

export const USER_EMAIL = "dana@example.com";

export type GmailCategory =
  | "PERSONAL"
  | "UPDATES"
  | "PROMOTIONS"
  | "SOCIAL"
  | "FORUMS";

export type ClassifyCase = {
  name: string;
  // What a careful human reader would say the message is.
  kind: "person" | "automated";
  // The label Gmail's own tab classifier would plausibly give it. The pipeline
  // does not pass this to the chooser today; it is kept for the confusion report.
  gmailCategory: GmailCategory;
  // A reply in an existing thread. In production the chooser then only sees
  // runOnThreads rules (Conversations) plus rules already applied in the thread.
  thread?: boolean;
  email: EmailForLLM;
  acceptable: string[];
  // A judge decides when the model picks something outside `acceptable`.
  ambiguous?: boolean;
};

const to = USER_EMAIL;

export const classifyCases: ClassifyCase[] = [
  // ---------------------------------------------------------------------------
  // Person-written mail that looks automated, transactional or bulk
  // ---------------------------------------------------------------------------
  {
    name: "helpdesk agent asks the user for a log file",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Priya (Support) <support@ledgerly.example>",
      to,
      subject: "[Ledgerly Support] Re: Sync stuck at 80% (Ticket #48213)",
      content: `##- Please type your reply above this line -##

Priya (Ledgerly Support)

Hi Dana,

Thanks for the screenshots. I tried to reproduce this on our side and couldn't. Could you export the sync log from Settings > Diagnostics and attach it here? Also, does it still stop at 80% if you sign out and back in?

Best,
Priya

This email is a service from Ledgerly Support. Ticket #48213.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "contractor sends an invoice and asks a question",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Marco Bianchi <marco@bianchirenovations.example>",
      to,
      subject: "Invoice #1042 - kitchen tiling",
      content: `Hi Dana,

Attached is the invoice for the tiling work, $2,350 total. The first half was already paid so $1,175 is outstanding.

One question before I order grout for the backsplash: did you decide between the white and the light grey? I need to know by Thursday to keep the schedule.

Thanks,
Marco`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "landlord's personal note about lease renewal",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Helen Park <helen.park@example.net>",
      to,
      subject: "Lease renewal notice",
      content: `Hi Dana,

Your lease is up at the end of next month. I'd be happy to renew for another year at the same rent. If you'd rather go month to month, that's possible too but it would be $75 more.

Let me know which you prefer and I'll draw up the paperwork.

Helen`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "accountant requests missing tax documents",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Raj Mehta CPA <raj@mehtatax.example>",
      to,
      subject: "Action required: documents for your 2025 return",
      content: `Hi Dana,

I'm working on your return and I'm still missing two things:
1. The 1099-INT from your savings account
2. Your HSA contribution statement

Can you upload them to the portal or just reply with them attached? I'd like to file before the 15th.

Regards,
Raj Mehta, CPA`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "colleague forwards a CI failure and asks for help",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Tom Okafor <tom@northwind.example>",
      to,
      subject: "Fwd: [northwind/api] Run failed: deploy-prod (main)",
      content: `Dana, this has failed three times since your migration merged. Can you take a look before standup? I don't want to roll back if it's a quick fix.

---------- Forwarded message ---------
From: CI Bot <ci@buildhub.example>
Subject: [northwind/api] Run failed: deploy-prod (main)

deploy-prod failed on main. Step "migrate" exited with code 1. View run: https://buildhub.example/northwind/api/runs/9921`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "teacher's message relayed by a school platform",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ms. Alvarez via ClassLink Messages <noreply@classlinkmsg.example>",
      to,
      subject: "New message from Ms. Alvarez",
      listUnsubscribe: "<https://classlinkmsg.example/unsub?u=synthetic>",
      content: `Ms. Alvarez sent you a message:

"Hi, Leo has been really quiet in class this week and seemed upset on Tuesday. Is everything ok at home? I'd be glad to set up a quick call if you'd like to talk."

Reply in ClassLink Messages: https://classlinkmsg.example/m/synthetic
You are receiving this because you are a parent contact. Manage notifications.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "customer replies to a shop owner's order confirmation",
    kind: "person",
    gmailCategory: "PERSONAL",
    thread: true,
    email: getEmail({
      from: "Grace Lin <grace.lin@example.org>",
      to,
      subject: "Re: Your order #3317 is confirmed",
      content: `Hi! I just placed this order but realised I picked the wrong size. Could you change the linen apron from M to L before it ships? Happy to pay any difference.

Thanks so much,
Grace

On Mon, Dana's Workshop <orders@danasworkshop.example> wrote:
> Thanks for your order! Order #3317: Linen apron (M) x1. Total $48.00.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "one-line phone-sent request from a friend",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Sam Ruiz <samruiz88@example.com>",
      to,
      subject: "(no subject)",
      content: `can you call me when you get a sec? nothing bad

Sent from my iPhone`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "friend pastes an expense split and asks to check it",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Ines Duarte <ines.duarte@example.com>",
      to,
      subject: "Lisbon trip - who owes what",
      content: `Ok I added everything up:

Airbnb: $840 (I paid)
Car rental: $310 (you paid)
Groceries: $96 (Sam paid)

Total $1,246, so $415.33 each. That means you owe me $105.33 and Sam owes me $319.33. Does that look right to you? I might have double counted the groceries.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "HR partner's personal nudge about benefits enrollment",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Keisha Brown <keisha.brown@northwind.example>",
      to,
      subject: "Open enrollment closes Friday",
      content: `Hi Dana,

I noticed you haven't made your benefits selections yet. If you don't, you'll be moved to the basic plan by default, and I know you added your partner last year.

Do you want to keep the same plan as last year? If so, just reply "same" and I can process it for you.

Keisha
People Team`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "property manager asks to confirm a repair visit via portal",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Oakview Residences <notifications@rentportal.example>",
      to,
      subject: "Message from your property manager",
      content: `You have a new message from Daniel (Oakview Residences):

"Hi Dana, the plumber can come Wednesday between 9 and 11 to fix the bathroom leak. Will someone be home, or are you ok with us letting him in with the master key?"

Reply to this message in your resident portal.
Oakview Residences | Powered by RentPortal`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "bank relationship manager asks for a signature",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Laura Chen <laura.chen@harborbank.example>",
      to,
      subject: "Following up on our call - signature needed",
      content: `Hi Dana,

Good speaking with you this morning. As discussed, I've attached the beneficiary change form. Could you sign page 2 and send it back by Friday? Once I have it I'll get it processed the same day.

Kind regards,
Laura Chen
Relationship Manager, Harbor Bank

This message may contain confidential information. If you received it in error, please notify the sender and delete it.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "parent writes in Spanish",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Carmen Ortega <carmen.ortega@example.es>",
      to,
      subject: "Cumpleaños de Lucía",
      content: `Hola Dana,

El sábado celebramos el cumpleaños de Lucía en el parque a las 4. ¿Puede venir Leo? Avísame para saber cuántos niños seremos.

Un abrazo,
Carmen`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "person closes the loop with a short thank-you",
    kind: "person",
    gmailCategory: "PERSONAL",
    thread: true,
    email: getEmail({
      from: "Nadia Haddad <nadia@haddaddesign.example>",
      to,
      subject: "Re: Logo files",
      content: `Got them, thank you! All good on my end.

Nadia

On Tue, Dana <dana@example.com> wrote:
> Here are the final logo files in SVG and PNG.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "client confirms a payment personally",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Ben Adler <ben@adlerco.example>",
      to,
      subject: "March payment sent",
      content: `Hey Dana,

Just sent $1,200 for March by bank transfer. It should land in 1-2 days. Let me know if it doesn't show up by Friday.

Also, are you free to start on the April deliverables next week?

Ben`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "club organiser asks the user directly on a group list",
    kind: "person",
    gmailCategory: "FORUMS",
    email: getEmail({
      from: "Ray Thompson <ray.t@example.com>",
      to: "riverside-chess@groups.example",
      subject: "[Riverside Chess] Thursday setup",
      listUnsubscribe: "<mailto:riverside-chess+unsubscribe@groups.example>",
      content: `Hi all, we're back in the library room this Thursday.

Dana, could you bring the projector again? Mine is still broken. Let me know either way so I can ask someone else.

Ray

--
You received this message because you are subscribed to the Riverside Chess group.`,
    }),
    acceptable: ["Conversations"],
    ambiguous: true,
  },
  {
    name: "doc share with a personal review request",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Tom Okafor (via DocsHub) <drive-shares-noreply@docshub.example>",
      to,
      subject: 'Document shared with you: "Q3 migration plan"',
      content: `Tom Okafor shared a document with you

"Dana, can you review section 3 by Friday? I need your sign-off on the rollback plan before I send it to the VP."

Q3 migration plan
Open: https://docshub.example/d/synthetic

You have received this email because tom@northwind.example shared a document with you.`,
    }),
    acceptable: ["Conversations"],
    ambiguous: true,
  },
  {
    name: "small moving company owner replies to the user's quote request",
    kind: "person",
    gmailCategory: "UPDATES",
    thread: true,
    email: getEmail({
      from: "QuickMove Quotes <quotes@quickmove.example>",
      to,
      subject: "Re: Your moving quote #Q-5510",
      content: `Hi Dana, this is Luis, the owner. I saw your reply. We can do the 14th but only in the afternoon, starting around 1pm. Would that work? If so I'll lock it in and the price stays at $680.

Luis

> Can you do the 14th instead of the 12th?
> On Fri, QuickMove Quotes wrote: Your quote is ready. 2-bedroom move, estimated $680.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "neighbour asks a favour, sent from a work account",
    kind: "person",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "Oliver Grant <ogrant@meridianlaw.example>",
      to,
      subject: "Package",
      content: `Hi Dana, it's Oliver from 4B. I'm away until Sunday and have a package arriving tomorrow. Any chance you could grab it from the lobby? No worries if not.

Oliver Grant | Associate | Meridian Law LLP
CONFIDENTIALITY NOTICE: This e-mail is intended only for the addressee and may contain privileged information.`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "buyer's question relayed by a marketplace",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "SwapLocal <messages@swaplocal.example>",
      to,
      subject: "Someone asked about your listing: Bike rack",
      listUnsubscribe: "<https://swaplocal.example/unsub?u=synthetic>",
      content: `New message about "Bike rack - fits 2 bikes":

"Hi, is this still available? Would you take $40 if I pick it up tonight? I'm about 10 minutes away."

Reply on SwapLocal. To keep your account safe, keep conversations on SwapLocal.
Manage email notifications | Unsubscribe`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "doctor's office scheduler asks to move an appointment",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Brookside Family Clinic <frontdesk@brooksideclinic.example>",
      to,
      subject: "Your appointment on the 22nd",
      content: `Hi Dana,

This is Maria from the front desk. Dr. Patel has to be out on the 22nd. Could we move your appointment to the 24th at 10:30 or the 27th at 2:00? Please reply with whichever works better.

Thank you,
Maria
Brookside Family Clinic`,
    }),
    acceptable: ["Conversations", "Calendar"],
  },
  {
    name: "colleague's FYI update with no request",
    kind: "person",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ana Silva <ana.silva@northwind.example>",
      to,
      subject: "Status: vendor contract",
      content: `Hi Dana,

Quick update so you're not surprised: legal signed off on the vendor contract this morning and procurement will countersign Monday. Nothing needed from you, I'll forward the final copy once it's done.

Ana`,
    }),
    acceptable: ["Conversations"],
  },
  {
    name: "thread reply from a person on a thread first filed as automated",
    kind: "person",
    gmailCategory: "PERSONAL",
    thread: true,
    email: getEmail({
      from: "Jordan Lee <jordan@fieldnotes.example>",
      to,
      subject: "Re: Your event registration is confirmed",
      content: `Hi Dana, I'm the organiser. I saw you registered for the workshop and that you're a teacher. We have a few free educator spots, so I can refund your ticket if you'd like. Want me to do that?

Jordan`,
    }),
    acceptable: ["Conversations"],
  },

  // ---------------------------------------------------------------------------
  // Automated mail that a person or the Primary tab might mistake for a conversation
  // ---------------------------------------------------------------------------
  {
    name: "out-of-office auto-reply",
    kind: "automated",
    gmailCategory: "PERSONAL",
    thread: true,
    email: getEmail({
      from: "Ana Silva <ana.silva@northwind.example>",
      to,
      subject: "Automatic reply: Status: vendor contract",
      content:
        "I'm out of the office until Monday with limited access to email. For urgent matters please contact procurement@northwind.example.",
    }),
    acceptable: ["Notification", "Conversations"],
    ambiguous: true,
  },
  {
    name: "doc comment notification quoting a colleague",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Tom Okafor (DocsHub) <comments-noreply@docshub.example>",
      to,
      subject: "Tom Okafor commented on Q3 migration plan",
      content: `Tom Okafor replied to a comment thread

"Looks fine to me now."

Q3 migration plan - 2 new comments
Open: https://docshub.example/d/synthetic
You received this email because you are subscribed to all discussions on this document.`,
    }),
    acceptable: ["Notification", "Conversations"],
    ambiguous: true,
  },
  {
    name: "chat app unread digest with names",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "TeamChat <notifications@teamchat.example>",
      to,
      subject: "You have 4 unread messages in #platform",
      content: `Hi Dana, you have new activity:

Tom Okafor: anyone know why deploy-prod is red?
Ana Silva: legal signed the vendor contract
Keisha Brown: reminder that open enrollment closes Friday

Open TeamChat to reply. Change how often you receive these emails.`,
    }),
    acceptable: ["Notification"],
  },
  {
    name: "issue tracker assignment",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "TrackFlow <noreply@trackflow.example>",
      to,
      subject: "[PLAT-482] Tom Okafor assigned this issue to you",
      content:
        "Tom Okafor assigned PLAT-482 to you: Rollback plan for Q3 migration. Priority: High. Due: Friday. View issue: https://trackflow.example/PLAT-482",
    }),
    acceptable: ["Notification"],
  },
  {
    name: "CI failure notification",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "CI Bot <ci@buildhub.example>",
      to,
      subject: "[northwind/api] Run failed: deploy-prod (main)",
      content:
        'deploy-prod failed on main. Step "migrate" exited with code 1. Triggered by a push from dana. View run: https://buildhub.example/northwind/api/runs/9921',
    }),
    acceptable: ["Notification"],
  },
  {
    name: "doorbell camera motion alert",
    kind: "automated",
    gmailCategory: "PERSONAL",
    email: getEmail({
      from: "HomeCam <alerts@homecam.example>",
      to,
      subject: "Motion detected at Front Door",
      content:
        "Motion was detected at Front Door at 3:42 PM. Watch the clip in the HomeCam app.",
    }),
    acceptable: ["Notification"],
  },
  {
    name: "bank low-balance alert",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Harbor Bank Alerts <alerts@harborbank.example>",
      to,
      subject: "Your checking balance is below $100",
      content:
        "Your Everyday Checking account ending in 0192 has a balance of $84.17 as of 6:00 AM. To change your alert settings, sign in to online banking. Please do not reply to this email.",
    }),
    acceptable: ["Notification"],
  },
  {
    name: "package shipped",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Parcelway <tracking@parcelway.example>",
      to,
      subject: "Your package is on its way",
      content:
        "Good news! Your order from Bianchi Supply has shipped. Tracking number 1Z999AA10123456784. Estimated delivery: Thursday. Track your package: https://parcelway.example/t/synthetic",
    }),
    acceptable: ["Notification", "Receipt"],
  },
  {
    name: "new sign-in security alert",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ledgerly <security@ledgerly.example>",
      to,
      subject: "New sign-in to your account",
      content:
        "We noticed a new sign-in to your Ledgerly account from Firefox on Windows. If this was you, you can ignore this message. If not, reset your password.",
    }),
    acceptable: ["Notification"],
  },
  {
    name: "verification code",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ledgerly <no-reply@ledgerly.example>",
      to,
      subject: "Your Ledgerly verification code",
      content:
        "Your verification code is 482913. It expires in 10 minutes. If you didn't request this, ignore this email.",
    }),
    acceptable: ["Notification"],
  },
  {
    name: "helpdesk auto-acknowledgement",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ledgerly Support <support@ledgerly.example>",
      to,
      subject: "[Ledgerly Support] We received your request (Ticket #48213)",
      content:
        "Thanks for contacting Ledgerly Support. Your request has been received and a member of our team will respond within 24 hours. Ticket #48213. You can add details by replying to this email.",
    }),
    acceptable: ["Notification"],
  },
  {
    name: "scheduling tool booking confirmation",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "MeetSlot <notifications@meetslot.example>",
      to,
      subject: "New event: Ben Adler - 30 min intro",
      content:
        "A new event has been scheduled. Invitee: Ben Adler. Event: 30 min intro. Date: Tuesday 10:00 AM. Location: video call. Add to your calendar or reschedule from your dashboard.",
    }),
    acceptable: ["Calendar", "Notification"],
  },
  {
    name: "social network connection request",
    kind: "automated",
    gmailCategory: "SOCIAL",
    email: getEmail({
      from: "ProNet <invitations@pronet.example>",
      to,
      subject: "Jordan Lee wants to connect",
      listUnsubscribe: "<https://pronet.example/unsub?u=synthetic>",
      content:
        'Jordan Lee, Workshop organiser at Fieldnotes, sent you an invitation: "Hi Dana, I\'d like to add you to my professional network." Accept or ignore. Unsubscribe from invitation emails.',
    }),
    acceptable: ["Notification"],
  },

  // Receipts
  {
    name: "ride receipt",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Zipride Receipts <receipts@zipride.example>",
      to,
      subject: "Your Thursday evening trip with Zipride",
      content:
        "Thanks for riding, Dana. Total: $23.40. Trip fare $19.10, booking fee $2.30, tip $2.00. Paid with Visa ending 4242. Driver: Ahmed. Rate your trip in the app.",
    }),
    acceptable: ["Receipt"],
  },
  {
    name: "online order confirmation",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Bianchi Supply <orders@bianchisupply.example>",
      to,
      subject: "Order confirmed: #BS-77120",
      content:
        "Thank you for your order! Order #BS-77120. Grout, light grey, 10 lb x2: $31.98. Shipping: $6.00. Tax: $2.88. Total charged: $40.86 to Visa ending 4242.",
    }),
    acceptable: ["Receipt"],
  },
  {
    name: "SaaS subscription invoice",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ledgerly Billing <billing@ledgerly.example>",
      to,
      subject: "Your Ledgerly invoice for October",
      content:
        "Invoice LDG-2210. Ledgerly Pro (monthly): $12.00. Paid on Oct 1 with Visa ending 4242. Download PDF from your billing settings.",
    }),
    acceptable: ["Receipt"],
  },
  {
    name: "payment app money received",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "QuickPay <service@quickpay.example>",
      to,
      subject: "Ines Duarte sent you $105.33",
      content:
        'Ines Duarte sent you $105.33. Note: "Lisbon trip". The money is in your QuickPay balance. View transaction details in the app.',
    }),
    acceptable: ["Receipt", "Notification"],
  },

  // Marketing
  {
    name: "founder-voice promo with unsubscribe",
    kind: "automated",
    gmailCategory: "PROMOTIONS",
    email: getEmail({
      from: "Sam from Brewbox <sam@mail.brewbox.example>",
      to,
      subject: "Quick favour, Dana?",
      listUnsubscribe: "<https://mail.brewbox.example/unsub?u=synthetic>",
      content: `Hey Dana,

Sam here, founder of Brewbox. I noticed you haven't ordered in a while and wanted to personally reach out. We've just launched a new single-origin from Colombia and I'd love for you to try it, so here's 25% off your next box with code SAM25.

Just hit reply if you have any questions, I read every email.

Sam

You're receiving this because you signed up at brewbox.example. Unsubscribe.`,
    }),
    acceptable: ["Marketing"],
  },
  {
    name: "abandoned cart reminder",
    kind: "automated",
    gmailCategory: "PROMOTIONS",
    email: getEmail({
      from: "Linenhouse <hello@linenhouse.example>",
      to,
      subject: "Did you forget something?",
      listUnsubscribe: "<https://linenhouse.example/unsub?u=synthetic>",
      content:
        "You left a Linen duvet cover (Queen, Sage) in your cart. It's still waiting for you, but stock is running low. Complete your order today and get free shipping.",
    }),
    acceptable: ["Marketing"],
  },
  {
    name: "seasonal sale",
    kind: "automated",
    gmailCategory: "PROMOTIONS",
    email: getEmail({
      from: "TrailGear <deals@trailgear.example>",
      to,
      subject: "48 hours only: 40% off rain jackets",
      listUnsubscribe: "<https://trailgear.example/unsub?u=synthetic>",
      content:
        "Our biggest sale of the season is here. 40% off all rain jackets and 25% off packs. Ends Sunday at midnight. Shop now.",
    }),
    acceptable: ["Marketing"],
  },
  {
    name: "re-engagement with a personal sign-off",
    kind: "automated",
    gmailCategory: "PROMOTIONS",
    email: getEmail({
      from: "Maya at Stretchly <maya@hello.stretchly.example>",
      to,
      subject: "We miss you, Dana",
      listUnsubscribe: "<https://hello.stretchly.example/unsub?u=synthetic>",
      content:
        "Hi Dana, it's been 30 days since your last session. Come back this week and your next month is on us. Hope to see you soon! - Maya, Stretchly Team. Unsubscribe or update preferences.",
    }),
    acceptable: ["Marketing"],
  },
  {
    name: "webinar invitation from a vendor",
    kind: "automated",
    gmailCategory: "PROMOTIONS",
    email: getEmail({
      from: "Ledgerly Events <events@ledgerly.example>",
      to,
      subject: "You're invited: closing the books faster",
      listUnsubscribe: "<https://ledgerly.example/unsub?u=synthetic>",
      content:
        "Join our product team live next Wednesday to see the new reconciliation tools. Save your seat and get a free month of Ledgerly Pro for attending.",
    }),
    acceptable: ["Marketing"],
  },

  // Newsletters
  {
    name: "writer's weekly newsletter inviting replies",
    kind: "automated",
    gmailCategory: "PROMOTIONS",
    email: getEmail({
      from: "The Slow Build <theslowbuild@letters.example>",
      to,
      subject: "Issue #87: Why small teams ship faster",
      listUnsubscribe: "<https://letters.example/theslowbuild/unsub>",
      content:
        "Hi friends, this week I'm writing about why five-person teams often outship fifty-person ones. Also: three tools I've stopped using. As always, hit reply and tell me what you think, I read everything. Read online.",
    }),
    acceptable: ["Newsletter"],
  },
  {
    name: "local news digest",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Riverside Daily <briefing@riversidedaily.example>",
      to,
      subject:
        "Morning briefing: library hours, road closures, weekend weather",
      listUnsubscribe: "<https://riversidedaily.example/unsub>",
      content:
        "Good morning. The library extends evening hours starting Monday. Elm St closes for repaving Tuesday to Thursday. Weekend: sunny, high of 72. Read more at riversidedaily.example.",
    }),
    acceptable: ["Newsletter"],
  },
  {
    name: "product changelog digest",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ledgerly <product@ledgerly.example>",
      to,
      subject: "What's new in Ledgerly: October",
      listUnsubscribe: "<https://ledgerly.example/unsub?u=synthetic>",
      content:
        "This month: bank rules now support regex, faster sync for large accounts, and a new dark mode. See the full changelog on our blog.",
    }),
    acceptable: ["Newsletter", "Notification", "Marketing"],
  },

  // Calendar
  {
    name: "meeting invitation",
    kind: "automated",
    gmailCategory: "UPDATES",
    email: getEmail({
      from: "Ana Silva <calendar-noreply@calendarhub.example>",
      to,
      subject: "Invitation: Vendor kickoff @ Mon 10am - 10:30am",
      content:
        "Ana Silva has invited you to Vendor kickoff. When: Monday 10:00 - 10:30. Video call link: https://meet.example/abc. Going? Yes - Maybe - No. Invitation from CalendarHub.",
    }),
    acceptable: ["Calendar"],
  },
];
