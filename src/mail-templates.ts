export interface MailContent { subject: string; text: string; html: string }

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

// Table layout with inline styles: the subset that Outlook, Gmail and mobile
// clients render consistently. Every message keeps a plain-text alternative.
function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">
<tr><td style="padding:0 8px 16px;${font};font-size:18px;font-weight:700;color:#18181b">26F Studio</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;${font};color:#27272a">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#18181b">${escape(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:16px 8px 0;${font};font-size:12px;line-height:1.5;color:#71717a">This message was sent by the 26F Studio account service because of a request for this address. Do not reply; this mailbox is not monitored.</td></tr>
</table></td></tr></table></body></html>`;
}
const paragraph = (value: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${escape(value)}</p>`;
const muted = (value: string) => `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#71717a">${escape(value)}</p>`;

function action(input: { subject: string; title: string; intro: string; label: string; url: string; note: string }): MailContent {
  const url = escape(input.url);
  const html = layout(input.title, `${paragraph(input.intro)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td bgcolor="#3b82f6" style="border-radius:8px">
<a href="${url}" target="_blank" style="display:inline-block;padding:12px 28px;${font};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escape(input.label)}</a>
</td></tr></table>
${muted(input.note)}
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#71717a">If the button does not work, copy this link into your browser:<br><a href="${url}" style="color:#3b82f6;word-break:break-all">${url}</a></p>`);
  return { subject: input.subject, html, text: `${input.title}\n\n${input.intro}\n\n${input.label}:\n${input.url}\n\n${input.note}\n` };
}

export const verificationMail = (url: string) => action({
  subject: 'Verify your 26F Studio email', title: 'Verify your email',
  intro: 'Confirm this address to finish setting up your 26F Studio account.', label: 'Verify email', url,
  note: 'This link expires in 30 minutes. If you did not create an account, ignore this message.',
});
export const passwordResetMail = (url: string) => action({
  subject: 'Reset your 26F Studio password', title: 'Reset your password',
  intro: 'Choose a new password for your 26F Studio account. Every signed-in browser and game session will be signed out.', label: 'Choose a new password', url,
  note: 'This single-use link expires in one hour. If you did not request it, ignore this message; your password stays unchanged.',
});
export const finishAccountMail = (url: string) => action({
  subject: 'Finish creating your 26F Studio account', title: 'Finish creating your account',
  intro: 'An account for this address is waiting for verification. Choose its password to verify the address and finish creating the account.', label: 'Choose password', url,
  note: 'This single-use link expires in one hour. If you did not try to create an account, ignore this message.',
});
export const emailChangeMail = (url: string, newEmail: string) => action({
  subject: 'Confirm your 26F Studio email change', title: 'Confirm your email change',
  intro: `A change of your account email to ${newEmail} was requested.`, label: 'Confirm email change', url,
  note: 'This link expires in 30 minutes. If this was not you, do not confirm, and change your password.',
});

const codePurpose: Record<string, string> = { 'sign-in': 'sign-in', 'email-verification': 'email verification', 'forget-password': 'password reset' };
export function codeMail(code: string, type: string): MailContent {
  const purpose = codePurpose[type] ?? 'verification';
  const title = `Your ${purpose} code`;
  const html = layout(title, `${paragraph(`Use this single-use code for your 26F Studio ${purpose}.`)}
<p style="margin:8px 0 24px;padding:16px;background:#f4f4f5;border-radius:8px;text-align:center;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#18181b">${escape(code)}</p>
${muted('The code expires in 5 minutes. Never share it with anyone, including people claiming to be 26F Studio staff.')}`);
  return {
    subject: `26F Studio ${purpose} code`, html,
    text: `${title}\n\nUse this single-use code for your 26F Studio ${purpose}:\n\n${code}\n\nThe code expires in 5 minutes. Never share it.\n`,
  };
}
