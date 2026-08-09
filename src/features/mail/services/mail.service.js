import { AppError } from '../../../shared/common/AppError.js';
import { User } from '../../auth/repositories/user.repository.js';
import {
  createEmail,
  findEmailsByUser,
  findEmailById,
  updateEmail,
  deleteEmail,
  countUnreadEmails
} from '../repositories/email.repository.js';

function parseRawMessage(raw) {
  const fromMatch = raw.match(/^From:\s*(.+)$/m);
  const toMatch = raw.match(/^To:\s*(.+)$/m);
  const subjectMatch = raw.match(/^Subject:\s*(.+)$/m);
  const dateMatch = raw.match(/^Date:\s*(.+)$/m);

  return {
    from: fromMatch ? fromMatch[1].trim() : '',
    to: toMatch ? toMatch[1].trim() : '',
    subject: subjectMatch ? subjectMatch[1].trim() : '',
    dateISO: dateMatch ? new Date(dateMatch[1].trim()).toISOString() : new Date().toISOString(),
    body: raw
  };
}

export class MailService {
  async receiveEmail({ to, from, subject, body, recipientUsername }) {
    const user = await User.findOne({ $or: [{ email: to }, { username: recipientUsername }] });
    if (!user) {
      throw new AppError(404, 'Recipient user not found');
    }

    const parsed = parseRawMessage(body);
    const finalFrom = parsed.from || from;
    const finalTo = parsed.to || to;
    const finalSubject = parsed.subject || subject || '(No Subject)';
    const timestamp = new Date().toLocaleString();

    const email = await createEmail({
      userId: user._id,
      from: finalFrom,
      to: finalTo,
      subject: finalSubject,
      body: parsed.body || body,
      folder: 'inbox',
      isUnread: true,
      isStarred: false,
      isPinned: false,
      isImportant: false,
      labels: [],
      attachments: [],
      dateISO: parsed.dateISO,
      timestamp
    });

    return email;
  }

  async sendEmail(userId, { to, subject, body, cc, bcc, priority, attachments }) {
    const sender = await User.findById(userId);
    if (!sender) {
      throw new AppError(404, 'Sender not found');
    }

    const timestamp = new Date().toLocaleString();
    const finalSubject = priority === 'high' ? `[URGENT] ${subject}` : subject;

    const sentEmail = await createEmail({
      userId,
      from: sender.email,
      to: to.trim(),
      subject: finalSubject,
      body: body || '',
      folder: 'sent',
      isUnread: false,
      isStarred: priority === 'high',
      isPinned: false,
      isImportant: priority === 'high',
      labels: priority === 'high' ? ['Important'] : [],
      attachments: attachments || [],
      dateISO: new Date().toISOString(),
      timestamp
    });

    return sentEmail;
  }

  async listInbox(userId, query = '') {
    return findEmailsByUser(userId, 'inbox', query);
  }

  async listSent(userId, query = '') {
    return findEmailsByUser(userId, 'sent', query);
  }

  async listFolder(userId, folder, query = '') {
    return findEmailsByUser(userId, folder, query);
  }

  async listStarred(userId) {
    return findEmailsByUser(userId, 'starred');
  }

  async getEmail(userId, emailId) {
    const email = await findEmailById(emailId);
    if (!email) {
      throw new AppError(404, 'Email not found');
    }
    if (email.userId.toString() !== userId.toString()) {
      throw new AppError(403, 'Access denied');
    }
    return email;
  }

  async markAsRead(userId, emailId) {
    const email = await this.getEmail(userId, emailId);
    return updateEmail(emailId, { isUnread: false });
  }

  async toggleStar(userId, emailId) {
    const email = await this.getEmail(userId, emailId);
    return updateEmail(emailId, { isStarred: !email.isStarred });
  }

  async togglePin(userId, emailId) {
    const email = await this.getEmail(userId, emailId);
    return updateEmail(emailId, { isPinned: !email.isPinned });
  }

  async moveToFolder(userId, emailId, folder) {
    await this.getEmail(userId, emailId);
    return updateEmail(emailId, { folder });
  }

  async deleteEmail(userId, emailId) {
    await this.getEmail(userId, emailId);
    return deleteEmail(emailId);
  }

  async getUnreadCount(userId, folder) {
    return countUnreadEmails(userId, folder);
  }
}
