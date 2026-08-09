import express from 'express';
import { authenticate } from '../../../middleware/auth.middleware.js';
import {
  receiveEmail,
  sendEmail,
  listInbox,
  listSent,
  listFolder,
  listStarred,
  getEmail,
  markAsRead,
  toggleStar,
  togglePin,
  moveToFolder,
  deleteEmail,
  getUnreadCount
} from '../controllers/mail.controller.js';

const router = express.Router();

router.post('/receive', receiveEmail);
router.post('/send', authenticate, sendEmail);
router.get('/inbox', authenticate, listInbox);
router.get('/sent', authenticate, listSent);
router.get('/folder/:folder', authenticate, listFolder);
router.get('/starred', authenticate, listStarred);
router.get('/:emailId', authenticate, getEmail);
router.patch('/:emailId/read', authenticate, markAsRead);
router.patch('/:emailId/star', authenticate, toggleStar);
router.patch('/:emailId/pin', authenticate, togglePin);
router.patch('/:emailId/move', authenticate, moveToFolder);
router.delete('/:emailId', authenticate, deleteEmail);
router.get('/unread/count', authenticate, getUnreadCount);

export default router;
