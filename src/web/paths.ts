/**
 * Where the web gateway keeps its data (S28, I52). Everything of a user lives under `<dataDir>\users\<userId>\`; the auth stores and the
 * audit sit next to it under `<dataDir>\web\` and `<dataDir>\web-audit\`. Pure: node:path only. A userId or botId that is not in the
 * strict pattern throws, so a path parameter can never carry `..`, a drive, or a separator into a path (I47).
 */
import { win32 } from "node:path";
import { isThreadId, isUserId, isWebBotId } from "./ids.js";

export interface WebPaths {
  webDir: string;
  usersFile: string;
  invitesFile: string;
  credentialsFile: string;
  sessionsFile: string;
  keyFile: string;
  modelsFile: string;
  modelKeysFile: string;
  claimFile: string;
  lockoutFile: string;
  auditDir: string;
  usersDir: string;
}

export function webPaths(dataDir: string): WebPaths {
  const webDir = win32.join(dataDir, "web");
  return {
    webDir,
    usersFile: win32.join(webDir, "users.json"),
    invitesFile: win32.join(webDir, "invites.json"),
    credentialsFile: win32.join(webDir, "credentials.json"),
    sessionsFile: win32.join(webDir, "sessions.json"),
    keyFile: win32.join(webDir, "web.key"),
    modelsFile: win32.join(webDir, "models.json"),
    modelKeysFile: win32.join(webDir, "model-keys.json"),
    claimFile: win32.join(webDir, "claim.json"),
    lockoutFile: win32.join(webDir, "lockout.json"),
    auditDir: win32.join(dataDir, "web-audit"),
    usersDir: win32.join(dataDir, "users"),
  };
}

export interface UserBotPaths {
  root: string;
  botFile: string;
  stateDir: string;
  storageFile: string;
  memoryDir: string;
  memoryFile: string;
  skillsDir: string;
  workspaceDir: string;
  logsDir: string;
}

export interface UserPaths {
  root: string;
  botsDir: string;
  prefsFile: string;
  threadsDir: string;
  uploadsDir: string;
  quotaFile: string;
  bot(botId: string): UserBotPaths;
  threadFile(botId: string, threadId: string): string;
}

export function userPaths(dataDir: string, userId: string): UserPaths {
  if (!isUserId(userId)) throw new Error("not a valid user id");
  const root = win32.join(dataDir, "users", userId);
  const botsDir = win32.join(root, "bots");
  const threadsDir = win32.join(root, "threads");
  return {
    root,
    botsDir,
    prefsFile: win32.join(root, "prefs.json"),
    threadsDir,
    uploadsDir: win32.join(root, "uploads"),
    quotaFile: win32.join(root, "quota.json"),
    bot(botId: string): UserBotPaths {
      if (!isWebBotId(botId)) throw new Error("not a valid bot id");
      const r = win32.join(botsDir, botId);
      return {
        root: r,
        botFile: win32.join(r, "bot.json"),
        stateDir: win32.join(r, "state"),
        storageFile: win32.join(r, "state", "agent.sqlite"),
        memoryDir: win32.join(r, "memory"),
        memoryFile: win32.join(r, "memory", "MEMORY.md"),
        skillsDir: win32.join(r, "skills"),
        workspaceDir: win32.join(r, "workspace"),
        logsDir: win32.join(r, "logs"),
      };
    },
    threadFile(botId: string, threadId: string): string {
      if (!isWebBotId(botId) || !isThreadId(threadId)) throw new Error("not a valid bot or thread id");
      return win32.join(threadsDir, botId, `${threadId}.json`);
    },
  };
}
