import type { ReactNode } from 'react';

// DRAFT for counsel review (security-threat-model.md §12). Every statement here must stay true to the code:
// retention numbers come from the `retention` config defaults; "not stored" items are enforced by design.

function Draft({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="prose-legal mx-auto max-w-3xl px-4 py-12">
      <p className="mb-4 rounded-md bg-amber-50 p-2 text-xs text-amber-800">Draft — pending legal review before launch.</p>
      <h1 className="text-3xl font-bold">{title}</h1>
      {children}
    </article>
  );
}

export function PrivacyPage() {
  return (
    <Draft title="Privacy">
      <h2>The short version</h2>
      <ul>
        <li>Your resume stays on your device. We don’t store your resume, your job descriptions or the rewritten resume on our servers.</li>
        <li>When you use AI features (tailoring, or refining a match), we send only the parts needed — your experience, skills and summary — with your name, email, phone number and profile links removed or replaced by placeholders. The AI provider processes it under API terms that don’t allow training on it, and we don’t keep it.</li>
        <li>We never log resume or job text, and we never sell data.</li>
      </ul>

      <h2>What stays on your device</h2>
      <p>The resume you upload, its parsed version, the job descriptions you analyze, scores and the resumes you export are stored in the extension’s storage in your browser, encrypted with a key that can’t be exported from the browser. “Delete all local data” in the extension’s settings removes them.</p>

      <h2>What we store on our servers</h2>
      <ul>
        <li><b>Account:</b> your email address (and your name, if you sign in with Google), sign-in sessions, your settings and your consent version — until you delete your account. With Google sign-in we receive only your name and email address from Google.</li>
        <li><b>Subscription:</b> your plan, its status and Stripe’s customer and subscription IDs. Stripe, our payment processor, holds your payment details and invoices; we never see your card.</li>
        <li><b>Usage:</b> counts of analyses and optimizations, and the cost and token counts of each AI request (never its content). AI request records are kept for 90 days, then only daily totals remain.</li>
        <li><b>Job analysis cache:</b> the structured requirements we derive from a public job posting, shared across users and not linked to you. Kept for 30 days after last use.</li>
        <li><b>Optimization results in transit:</b> while an optimization runs, the result is held encrypted for at most 24 hours so the extension can collect it, then deleted.</li>
        <li><b>Saved content, only if you opt in:</b> if you turn on “Help improve Job Match Optimizer” (off by default), we save the job posts you analyze, the resume you send for tailoring with your name and contact details removed, and the tailored results, to analyze and improve the product. They are encrypted, kept for 12 months, included in your data download, and deleted when you turn the setting off, choose “Delete saved data” or delete your account. Only our owner and administrators can open them, and every access is logged.</li>
        <li><b>Feedback:</b> ratings and any comment you write, for up to 24 months. Resume text is included only if you choose to share it.</li>
        <li><b>Security logs:</b> sign-in events and a salted hash of your IP address, for 90 days.</li>
      </ul>

      <h2>Who processes data for us</h2>
      <ul>
        <li><b>AI providers</b> (currently OpenAI’s API) process the minimized resume text only to produce your rewrite or match. If you use your own API key, that text goes from your browser straight to your provider and never reaches us. We use only providers whose terms allow this data and don’t train on it; trial or free-tier services are never used with your data.</li>
        <li><b>Stripe</b> processes payments and stores payment details.</li>
        <li><b>Hosting, database and email</b> providers run our service and send your sign-in codes.</li>
      </ul>
      <p>Some of these providers are outside Canada (for example in the United States), so your information may be processed there and be subject to those countries’ laws.</p>

      <h2>Your choices and rights</h2>
      <ul>
        <li>Download your account data or delete your account at any time on the <a className="text-indigo-700 underline" href="/account">account page</a>. Deletion cancels any subscription, removes your account and usage records, and removes your identity from AI cost records.</li>
        <li>You can use the extension’s local features without an account, and you can bring your own AI provider key, which stays in your browser.</li>
        <li>Depending on where you live (for example under PIPEDA, Quebec’s Law 25, the GDPR or the CCPA), you may have further rights to access, correct or port your data, or to complain to a regulator. Contact us to exercise them.</li>
      </ul>

      <h2>Contact</h2>
      <p>Privacy questions: <span className="font-mono">privacy@[your-domain]</span>. We are based in Canada.</p>
    </Draft>
  );
}

export function TermsPage() {
  return (
    <Draft title="Terms of use">
      <h2>What the service does</h2>
      <p>Job Match Optimizer suggests edits to your resume for a specific job posting. Suggestions are limited to facts already in your resume; you review and accept each change. You are responsible for the accuracy of the resume you submit to employers.</p>
      <h2>The match score</h2>
      <p>The match score is our own estimate of how well your resume covers a posting’s requirements, shown with a confidence level. It is not an applicant tracking system (ATS) score and does not predict any employer’s decision.</p>
      <h2>Plans and billing</h2>
      <p>Paid plans renew automatically until cancelled. You can cancel at any time from your account page; you keep access until the end of the paid period. Payments are processed by Stripe; we never see your card details. Coupon codes are subject to the conditions shown when you apply them.</p>
      <h2>Fair use</h2>
      <p>Plans include monthly and daily limits shown in the extension. Automated or abusive use, account sharing or attempts to bypass limits may lead to suspension.</p>
      <h2>Changes</h2>
      <p>We will notify you in the extension before material changes to these terms or to how we handle your data take effect.</p>
    </Draft>
  );
}
