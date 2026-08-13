import { UserService } from '../services/user.service.js';

const userServices = new UserService();

//-------------------------------------------------------------------------------------------get user
export const getUserByIdController = async (req, res) => {
    try {
        const { id } = req.params;
        const user = await userServices.getUserById(id);
        res.status(200).json({ success: true, message: "User fetched successfully", data: user });
    } catch (error) {
        res.status(404).json({ success: false, message: "Error fetching user", error })
    }
}

//-------------------------------------------------------------------------------------------Update user
export const updateUserController = async (req, res) => {
    try {
        const { id } = req.params;
        const { data } = req.body;
        const updatedUser = await userServices.updateUser(id, data);
        res.status(200).json({ success: true, message: "User updated", data: updatedUser })
    } catch (error) {
        res.status(400).json({ success: false, message: "Error updating user", error });
    }
}

//-------------------------------------------------------------------------------------------Delete user
export const deleteUserController = async (req, res) => {
    try {
        const { id } = req.params;
        const deletedUser = await userServices.deleteUser(id);
        res.status(204).json({ success: true, message: "User deleted permanantly", data: deleteUser });
    } catch (error) {
        res.status(400).json({ success: false, message: "Error deleting user", error });
    }
}
