import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_URL = process.env.API_URL;
const basePath = "/searches";

export const getAllActiveSearches = async () => {
  try {
    const res = await axios.get(`${API_URL}${basePath}`);
    return res.data;
  } catch (err) {
    console.error(err.message);
    return [];
  }
};

export const getActiveSearchesByUser = async (userId) => {
  try {
    const res = await axios.get(`${API_URL}${basePath}/user/${userId}`);
    return res.data;
  } catch (err) {
    console.error(err.message);
    return [];
  }
};

export const createSearch = async ({
  userId,
  fromStationCode,
  toStationCode,
  seatType,
  travelDate,
  tripList,
}) => {
  try {
    const res = await axios.post(`${API_URL}${basePath}`, {
      userId,
      fromStationCode,
      toStationCode,
      seatType,
      travelDate,
      tripList,
    });
    return res.data;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const message = err.response.data?.message;
      const error = new Error(message);
      error.status = status;
      throw error;
    }
    throw err;
  }
};

export const foundSearch = async (id) => {
  try {
    const res = await axios.post(`${API_URL}${basePath}/foundSearch`, { id });
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
};

export const stopSearch = async (id) => {
  try {
    const res = await axios.post(`${API_URL}${basePath}/stopSearch`, { id });
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
};

export const stopErrorSearch = async (id) => {
  try {
    const res = await axios.post(`${API_URL}${basePath}/stopErrorSearch`, {
      id,
    });
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
};

export const stopExpiredSearches = async () => {
  try {
    const res = await axios.post(`${API_URL}${basePath}/stopExpired`);
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
};

export const refreshSearchTripList = async (id) => {
  try {
    const res = await axios.post(`${API_URL}${basePath}/refreshSearchTrips`, {
      id,
    });
    return res.data;
  } catch (err) {
    console.error(err.message);
    return null;
  }
};
