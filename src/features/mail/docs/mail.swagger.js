/**
 * @openapi
 * /mail/receive:
 *   post:
 *     tags: [Mail]
 *     summary: Receive an email (used by mail microservice)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, from]
 *             properties:
 *               to:
 *                 type: string
 *                 example: john@diveosx.com
 *               from:
 *                 type: string
 *                 example: sarah@diveosx.com
 *               subject:
 *                 type: string
 *                 example: Hello
 *               body:
 *                 type: string
 *               recipientUsername:
 *                 type: string
 *                 example: john
 *     responses:
 *       201:
 *         description: Email received successfully
 *       404:
 *         description: Recipient user not found
 */

/**
 * @openapi
 * /mail/send:
 *   post:
 *     tags: [Mail]
 *     summary: Send an email
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, subject]
 *             properties:
 *               to:
 *                 type: string
 *                 example: sarah@diveosx.com
 *               subject:
 *                 type: string
 *               body:
 *                 type: string
 *               cc:
 *                 type: string
 *               bcc:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [normal, high, low]
 *               attachments:
 *                 type: array
 *     responses:
 *       201:
 *         description: Email sent successfully
 */

/**
 * @openapi
 * /mail/inbox:
 *   get:
 *     tags: [Mail]
 *     summary: List inbox emails
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Inbox emails returned
 */

/**
 * @openapi
 * /mail/sent:
 *   get:
 *     tags: [Mail]
 *     summary: List sent emails
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sent emails returned
 */

/**
 * @openapi
 * /mail/folder/{folder}:
 *   get:
 *     tags: [Mail]
 *     summary: List emails in a folder
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: folder
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Folder emails returned
 */

/**
 * @openapi
 * /mail/starred:
 *   get:
 *     tags: [Mail]
 *     summary: List starred emails
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Starred emails returned
 */

/**
 * @openapi
 * /mail/{emailId}:
 *   get:
 *     tags: [Mail]
 *     summary: Get email by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email returned
 *       404:
 *         description: Email not found
 */

/**
 * @openapi
 * /mail/{emailId}/read:
 *   patch:
 *     tags: [Mail]
 *     summary: Mark email as read
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email marked as read
 */

/**
 * @openapi
 * /mail/{emailId}/star:
 *   patch:
 *     tags: [Mail]
 *     summary: Toggle email star
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Star toggled
 */

/**
 * @openapi
 * /mail/{emailId}/pin:
 *   patch:
 *     tags: [Mail]
 *     summary: Toggle email pin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pin toggled
 */

/**
 * @openapi
 * /mail/{emailId}/move:
 *   patch:
 *     tags: [Mail]
 *     summary: Move email to folder
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [folder]
 *             properties:
 *               folder:
 *                 type: string
 *                 enum: [inbox, sent, drafts, trash, spam, archive]
 *     responses:
 *       200:
 *         description: Email moved
 */

/**
 * @openapi
 * /mail/{emailId}:
 *   delete:
 *     tags: [Mail]
 *     summary: Delete email
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email deleted
 */

/**
 * @openapi
 * /mail/unread/count:
 *   get:
 *     tags: [Mail]
 *     summary: Get unread email count
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: folder
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unread count returned
 */
