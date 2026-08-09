/**
 * @openapi
 * /files:
 *   post:
 *     tags: [Files]
 *     summary: Create a file or folder
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [file, folder]
 *               parentId:
 *                 type: string
 *               content:
 *                 type: string
 *               mimeType:
 *                 type: string
 *     responses:
 *       201:
 *         description: File created
 */

/**
 * @openapi
 * /files/{fileId}:
 *   get:
 *     tags: [Files]
 *     summary: Get file by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File returned
 *       404:
 *         description: File not found
 */

/**
 * @openapi
 * /files/children/{parentId}:
 *   get:
 *     tags: [Files]
 *     summary: List children of a folder
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: parentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Children returned
 */

/**
 * @openapi
 * /files/{fileId}:
 *   patch:
 *     tags: [Files]
 *     summary: Update file metadata
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               starred:
 *                 type: boolean
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: File updated
 */

/**
 * @openapi
 * /files/{fileId}/move:
 *   patch:
 *     tags: [Files]
 *     summary: Move file to another folder
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [parentId]
 *             properties:
 *               parentId:
 *                 type: string
 *     responses:
 *       200:
 *         description: File moved
 */

/**
 * @openapi
 * /files/{fileId}:
 *   delete:
 *     tags: [Files]
 *     summary: Soft delete file
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File moved to trash
 */

/**
 * @openapi
 * /files/{fileId}/restore:
 *   patch:
 *     tags: [Files]
 *     summary: Restore deleted file
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File restored
 */

/**
 * @openapi
 * /files/{fileId}/permanent:
 *   delete:
 *     tags: [Files]
 *     summary: Permanently delete file
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File permanently deleted
 */

/**
 * @openapi
 * /files/trash:
 *   get:
 *     tags: [Files]
 *     summary: List deleted files
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Trash files returned
 */

/**
 * @openapi
 * /files/search:
 *   get:
 *     tags: [Files]
 *     summary: Search files
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Search results returned
 */

/**
 * @openapi
 * /files/starred:
 *   get:
 *     tags: [Files]
 *     summary: List starred files
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Starred files returned
 */

/**
 * @openapi
 * /files/{fileId}/star:
 *   patch:
 *     tags: [Files]
 *     summary: Toggle file star
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Star toggled
 */

/**
 * @openapi
 * /files/{fileId}/pin:
 *   patch:
 *     tags: [Files]
 *     summary: Toggle folder pin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pin toggled
 */

/**
 * @openapi
 * /files/pinned:
 *   get:
 *     tags: [Files]
 *     summary: List pinned folders
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pinned folders returned
 */
