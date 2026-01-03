import dotenv from "dotenv";
import { startTelegramBot } from "./platforms/telegramBot.js";

dotenv.config();

startTelegramBot();