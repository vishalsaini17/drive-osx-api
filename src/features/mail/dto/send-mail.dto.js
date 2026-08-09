export class SendMailDto {
  constructor({ to, subject, body, cc, bcc, priority, attachments }) {
    this.to = to;
    this.subject = subject;
    this.body = body;
    this.cc = cc;
    this.bcc = bcc;
    this.priority = priority;
    this.attachments = attachments;
  }
}
