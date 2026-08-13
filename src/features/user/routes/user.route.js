import { Router } from "express";
import { getUserByIdController, updateUserController, deleteUserController } from '../controllers/user.controller.js'
const router = Router();

router.get("/user/:id", getUserByIdController);
router.put("/user/:id", updateUserController);
router.delete("/user/:id", deleteUserController);

export default router;