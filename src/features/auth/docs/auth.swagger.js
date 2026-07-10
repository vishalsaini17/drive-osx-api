/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     responses:
 *       200:
 *         description: API is healthy
 */

/**
 * @openapi
 * /register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, fullName, recoveryEmail]
 *             properties:
 *               username:
 *                 type: string
 *                 example: john
 *               password:
 *                 type: string
 *                 example: password123
 *               fullName:
 *                 type: string
 *                 example: John Doe
 *               recoveryEmail:
 *                 type: string
 *                 example: john@gmail.com
 *               mobile:
 *                 type: string
 *                 example: +919876543210
 *     responses:
 *       201:
 *         description: User created successfully
 */

/**
 * @openapi
 * /login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in a user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *                 example: john
 *               password:
 *                 type: string
 *                 example: password123
 *     responses:
 *       200:
 *         description: Login successful
 */

/**
 * @openapi
 * /profile:
 *   get:
 *     tags: [Auth]
 *     summary: Get authenticated user profile
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *       401:
 *         description: Unauthorized
 */

/**
 * @openapi
 * /workspaces:
 *   post:
 *     tags: [Workspaces]
 *     summary: Create a personal or organization workspace
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Acme Corp
 *               type:
 *                 type: string
 *                 enum: [personal, organization]
 *                 example: organization
 *     responses:
 *       201:
 *         description: Workspace created successfully
 */

/**
 * @openapi
 * /workspaces:
 *   get:
 *     tags: [Workspaces]
 *     summary: List all workspaces a user belongs to
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Workspace list returned successfully
 */

/**
 * @openapi
 * /forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request password reset
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 default: john@example.com
 *                 example: john@example.com
 *     responses:
 *       200:
 *         description: Password reset link has been sent to your email
 *       404:
 *         description: User not found
 */

/**
 * @openapi
 * /reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Reset password with token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token:
 *                 type: string
 *                 example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *               password:
 *                 type: string
 *                 default: newpassword123
 *                 example: newpassword123
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: Invalid or expired reset token
 */
