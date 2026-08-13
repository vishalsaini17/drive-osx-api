import { User } from "../../auth/repositories/user.repository.js";

export class UserService {
    // ------------------------------------------------------------------------------GET USER BY ID
    getUserById = async (id) => {
        try {
            if (!id) {
                throw new Error("User id is required")
            }
            const user = await User.findById(id).select('-password');
            return user;
        } catch (error) {
            console.error("Error fetch user", error);
        }
    }

    // ------------------------------------------------------------------------------UPDATE USER
    updateUser = async (id, data) => {
        try {
            if (!id) {
                throw new Error("User id is required")
            }
            const updatedUser = await User.findByIdAndUpdate(
                id,
                data,
                {
                    new: true,
                    runValidators: true
                }
            ).select('-password');
            if (!updatedUser) {
                throw new Error("User not found")
            }
            return updatedUser;
        } catch (error) {
            throw error;
        }
    }

    //--------------------------------------------------------------------------------DELETE USER
    deleteUser = async (id) => {
        try {
            if (!id) {
                throw new Error("User id is required");
            }

            const deletedUser = await User.findByIdAndDelete(id);

            if (!deletedUser) {
                throw new Error("User not found");
            }

            return deletedUser;
        } catch (error) {
            throw error;
        }
    };
}

