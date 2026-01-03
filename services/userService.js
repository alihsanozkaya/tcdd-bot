import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_URL = process.env.API_URL;
const basePath = "/users";

export const findOrCreateUser = async (telegramId) => {
  try {
    const res = await axios.post(`${API_URL}${basePath}`, { telegramId });
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
};

export const getChatIdByUserId = async (userId) => {
  try {
    const res = await axios.get(`${API_URL}${basePath}/getChatIdByUserId/${userId}`);
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
}