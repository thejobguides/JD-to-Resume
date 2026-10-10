// Transactional email. Development prints to the console; production uses Resend (architecture.md §19).
// CASL: this is transactional mail only (sign-in codes, receipts). Marketing mail needs separate consent.

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function consoleMailer(log: (s: string) => void = console.log): Mailer {
  return {
    async send(to, subject, text) {
      log(`[mail] to=${to} subject="${subject}"\n${text}`);
    },
  };
}

export function resendMailer(apiKey: string, from: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    async send(to, subject, text) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new Error(`email send failed: ${res.status}`);
    },
  };
}
