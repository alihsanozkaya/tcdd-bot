import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_URL = process.env.API_URL;
const basePath = "/stations";

export const getAllStations = async () => {
  try {
    const res = await axios.get(`${API_URL}${basePath}`);
    return res.data || [];
  } catch (err) {
    console.error(err.message);
    return [];
  }
};
