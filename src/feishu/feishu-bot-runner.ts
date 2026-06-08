import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig, BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { createEventDispatcher } from './event-handler.js';
import { MessageSender } from './message-sender.js';
import { FeishuSenderAdapter } from './feishu-sender-adapter.js';
import { MessageBridge } from '../bridge/message-bridge.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';

export interface FeishuBotHandle {
  name: string;
  bridge: MessageBridge;
  wsClient: lark.WSClient;
  config: BotConfigBase;
  sender: IMessageSender;
  feishuClient: lark.Client;
}

/**
 * Start a single Feishu bot: build the SDK client, fetch bot identity, wire the
 * event dispatcher to a MessageBridge, and open the WebSocket connection.
 *
 * Shared by startup ([src/index.ts]) and live onboarding ([feishu-onboard-routes.ts])
 * so a freshly QR-registered bot can hot-activate without a restart.
 */
export async function startFeishuBot(
  botConfig: BotConfig,
  logger: Logger,
  memoryServerUrl: string,
  memorySecret?: string,
): Promise<FeishuBotHandle> {
  const botLogger = logger.child({ bot: botConfig.name });

  botLogger.info('Starting Feishu bot...');

  // Resolve open-platform domain (feishu = China, lark = International).
  const domain = botConfig.feishu.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

  // Create Feishu API client
  const client = new lark.Client({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    domain,
    disableTokenCache: false,
  });

  // Fetch bot info to get bot's open_id for accurate @mention detection
  let botOpenId: string | undefined;
  try {
    const botInfo: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = botInfo?.bot?.open_id;
    if (botOpenId) {
      botLogger.info({ botOpenId }, 'Bot info fetched');
    } else {
      botLogger.warn('Could not get bot open_id. Ensure the Feishu app has Bot capability enabled and the app version is published.');
    }
  } catch (err: any) {
    botLogger.warn({ err: err?.message || err }, 'Failed to fetch bot info. Check: 1) Bot capability is enabled in Feishu app 2) App is published 3) App credentials are correct');
  }

  // Create sender and bridge (FeishuSenderAdapter wraps the Feishu-specific MessageSender)
  const rawSender = new MessageSender(client, botLogger);
  const sender = new FeishuSenderAdapter(rawSender);
  const bridge = new MessageBridge(botConfig, botLogger, sender, memoryServerUrl, memorySecret);

  // Create event dispatcher wired to the bridge
  const dispatcher = createEventDispatcher(
    botConfig,
    botLogger,
    (msg) => {
      bridge.handleMessage(msg).catch((err) => {
        botLogger.error({ err, msg }, 'Unhandled error in message bridge');
      });
    },
    botOpenId,
    rawSender,
    (event) => {
      bridge.handleCardAction(event).catch((err) => {
        botLogger.error({ err, event }, 'Unhandled error in card action handler');
      });
    },
  );

  // Create WebSocket client
  const wsClient = new lark.WSClient({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.info,
  });

  // Start WebSocket connection with event dispatcher
  await wsClient.start({ eventDispatcher: dispatcher });

  botLogger.info('Feishu bot is running');
  botLogger.info({
    defaultWorkingDirectory: botConfig.claude.defaultWorkingDirectory,
    maxTurns: botConfig.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: botConfig.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return { name: botConfig.name, bridge, wsClient, config: botConfig, sender, feishuClient: client };
}
