// Writes docs/emails/binchika-general.html: the general branded template (functions/_lib/emails.js general()) filled
// with sample text, so it can be opened in a browser or copied into another mail tool. The dashboard's Compose uses the
// same function, so this file always matches what recipients see. Usage: node scripts/build-email-template.mjs
import { writeFile } from "node:fs/promises";
import { general } from "../functions/_lib/emails.js";
import { MAILBOXES, textToHtml } from "../functions/_lib/mailbox.js";

const box = MAILBOXES.ops;
const body = `Good afternoon,

Thank you for your interest in volunteering with Binchika. This is a sample of the branded email the BinchikAdmin sends from the dashboard's Inbox & Sent tab.

Write in plain text. Leave a blank line between paragraphs, and links such as https://binchika.com/verifiers/ become clickable.

Kind regards,`;
const { html } = general({ subject: "Sample: Binchika general email", bodyHtml: textToHtml(body), signOff: box.name, from: box.address, preheader: "A sample of the general Binchika email template." });
await writeFile("docs/emails/binchika-general.html", html);
console.log("wrote docs/emails/binchika-general.html", html.length, "bytes");
