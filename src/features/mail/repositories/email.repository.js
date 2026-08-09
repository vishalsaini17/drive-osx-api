import mongoose from 'mongoose';
import { Email } from '../models/email.model.js';

export async function createEmail(payload) {
  return Email.create(payload);
}

export async function findEmailsByUser(userId, folder, query = '') {
  const filter = { userId };

  if (folder && folder !== 'starred' && folder !== 'important') {
    filter.folder = folder;
  }

  if (query) {
    filter.$text = { $search: query };
  }

  let emails = Email.find(filter).sort({ createdAt: -1 });

  if (folder === 'starred') {
    emails = emails.where('isStarred').equals(true);
  } else if (folder === 'important') {
    emails = emails.where('isImportant').equals(true);
  }

  return emails;
}

export async function findEmailById(emailId) {
  return Email.findById(emailId);
}

export async function updateEmail(emailId, payload) {
  return Email.findByIdAndUpdate(emailId, payload, { new: true });
}

export async function deleteEmail(emailId) {
  return Email.findByIdAndDelete(emailId);
}

export async function countUnreadEmails(userId, folder) {
  const filter = { userId, isUnread: true };
  if (folder) filter.folder = folder;
  return Email.countDocuments(filter);
}
