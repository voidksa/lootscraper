import express from "express";
import fs from "fs";
import path from "path";
import { browserService } from "@/services/browser";
import { config } from "@/services/config";
import { database } from "@/services/database";
import { telegramBotService } from "@/services/telegrambot";
import type { Config } from "@/types";
import { addTelegramTransport, logger } from "@/utils/logger";
import { feedService } from "./feed";
import { ftpService } from "./ftp";
import { gameInfoService } from "./gameinfo";
import { scraperService } from "./scraper";
import { translationService } from "./translation";

interface ServiceState {
  isRunning: boolean;
}

const state: ServiceState = {
  isRunning: false,
};

/**
 * Initialize application services based on config
 */
export async function startApp(): Promise<void> {
  if (state.isRunning) {
    logger.warn("App already started.");
    return;
  }

  try {
    const cfg = config.get();

    // Initialize services
    logger.info("Inizializing services.");
    await initializeServices(cfg);

    // Start services
    logger.info("Starting services.");
    await startServices();
    state.isRunning = true;

    // Register shutdown handlers
    registerShutdownHandlers();

    // Run initial tasks
    logger.info("Running initial tasks.");
    if (cfg.actions.generateFeed) {
      await feedService.updateFeeds();
    }
    if (cfg.actions.generateFeed && cfg.actions.uploadToFtp) {
      await ftpService.uploadEnabledFeedsToServer();
    }

    // Start Express server
    const app = express();
    const port = process.env.PORT || 3000;

    app.get("/lootscraper_epic_game.xml", (req, res) => {
      const filePath = path.join(process.cwd(), "public", "lootscraper_epic_game.xml");
      if (fs.existsSync(filePath)) {
        res.setHeader("Content-Type", "application/xml");
        res.sendFile(filePath);
      } else {
        res.status(404).send("XML file not found.");
      }
    });

    app.get("/", (req, res) => {
      res.send("✅ LootScraper is running!");
    });

    app.listen(port, () => {
      logger.info(`HTTP server running on port ${port}`);
    });

  } catch (error) {
    await shutdownApp();
    throw error;
  }
}

async function initializeServices(cfg: Config): Promise<void> {
  logger.info("Initializing translation service.");
  await translationService.initialize();

  logger.info("Initializing database service.");
  await database.initialize(cfg);

  if (cfg.actions.telegramBot) {
    logger.info("Initializing Telegram bot.");
    await telegramBotService.initialize(cfg);
    logger.info("Adding Telegram transport to logger.");
    addTelegramTransport(cfg.telegram.logLevel, cfg.telegram.botLogChatId);
  }

  if (cfg.actions.generateFeed) {
    logger.info("Initializing feed service.");
    feedService.initialize(cfg);
  }

  if (cfg.actions.uploadToFtp) {
    logger.info("Initializing FTP service.");
    ftpService.initialize(cfg);
  }

  if (cfg.actions.scrapeOffers || cfg.actions.scrapeInfo) {
    logger.info("Initializing browser service.");
    await browserService.initialize(cfg);
  }

  if (cfg.actions.scrapeOffers) {
    logger.info("Initializing scraper service.");
    await scraperService.initialize(cfg);
  }

  if (cfg.actions.scrapeInfo) {
    logger.info("Initializing game info service.");
    gameInfoService.initialize(cfg);
  }
}

async function startServices() {
  const cfg = config.get();

  if (cfg.actions.telegramBot) {
    telegramBotService.start();
  }

  if (cfg.actions.scrapeOffers) {
    await scraperService.start();
  }
}

export async function shutdownApp(): Promise<void> {
  logger.info("Stopping services...");
  await telegramBotService.stop();
  await scraperService.stop();
  logger.info("Destroying services...");
  await browserService.destroy();
  await database.destroy();
  state.isRunning = false;
  logger.info("Services shutdown complete");
}

function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    await shutdownApp();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    void shutdown("UNCAUGHT_EXCEPTION");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled Promise rejection:", reason);
    void shutdown("UNHANDLED_REJECTION");
  });
}
