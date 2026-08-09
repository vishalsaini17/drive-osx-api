import { AppError } from '../../../shared/common/AppError.js';
import { SendMailDto } from '../dto/send-mail.dto.js';

export function validateSendMailInput({ to, subject, body, cc, bcc, priority, attachments }) {
  if (!to || !subject) {
    throw new AppError(400, 'to and subject are required');
  }

  if (typeof to !== 'string' || typeof subject !== 'string') {
    throw new AppError(400, 'to and subject must be strings');
  }

  if (body !== undefined && typeof body !== 'string') {
    throw new AppError(400, 'body must be a string');
  }

  if (priority !== undefined && !['normal', 'high', 'low'].includes(priority)) {
    throw new AppError(400, 'priority must be normal, high, or low');
  }
}
