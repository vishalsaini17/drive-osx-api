import { asyncHandler } from '../../../shared/common/asyncHandler.js';
import { MailService } from '../services/mail.service.js';
import { SendMailDto } from '../dto/send-mail.dto.js';
import { validateSendMailInput } from '../validators/mail.validator.js';
import { authenticate } from '../../../middleware/auth.middleware.js';

const mailService = new MailService();

export const receiveEmail = asyncHandler(async (req, res) => {
  const { to, from, subject, body, recipientUsername } = req.body || {};

  if (!to || !from) {
    return res.status(400).json({ message: 'to and from are required' });
  }

  const email = await mailService.receiveEmail({
    to,
    from,
    subject,
    body,
    recipientUsername
  });

  res.status(201).json({ message: 'Email received', email });
});

export const sendEmail = asyncHandler(async (req, res) => {
  const dto = new SendMailDto(req.body);
  validateSendMailInput(dto);

  const userId = req.user.id;
  const email = await mailService.sendEmail(userId, dto);
  res.status(201).json({ message: 'Email sent', email });
});

export const listInbox = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const query = req.query.q || '';
  const emails = await mailService.listInbox(userId, query);
  res.json({ emails });
});

export const listSent = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const query = req.query.q || '';
  const emails = await mailService.listSent(userId, query);
  res.json({ emails });
});

export const listFolder = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { folder } = req.params;
  const query = req.query.q || '';
  const emails = await mailService.listFolder(userId, folder, query);
  res.json({ emails });
});

export const listStarred = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const emails = await mailService.listStarred(userId);
  res.json({ emails });
});

export const getEmail = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { emailId } = req.params;
  const email = await mailService.getEmail(userId, emailId);
  res.json({ email });
});

export const markAsRead = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { emailId } = req.params;
  const email = await mailService.markAsRead(userId, emailId);
  res.json({ message: 'Email marked as read', email });
});

export const toggleStar = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { emailId } = req.params;
  const email = await mailService.toggleStar(userId, emailId);
  res.json({ message: 'Star toggled', email });
});

export const togglePin = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { emailId } = req.params;
  const email = await mailService.togglePin(userId, emailId);
  res.json({ message: 'Pin toggled', email });
});

export const moveToFolder = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { emailId } = req.params;
  const { folder } = req.body;
  const email = await mailService.moveToFolder(userId, emailId, folder);
  res.json({ message: 'Email moved', email });
});

export const deleteEmail = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { emailId } = req.params;
  await mailService.deleteEmail(userId, emailId);
  res.json({ message: 'Email deleted' });
});

export const getUnreadCount = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { folder } = req.query;
  const count = await mailService.getUnreadCount(userId, folder);
  res.json({ count });
});
