import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

const MEMBER_NAME_TTL_MS = 10 * 60 * 1000;

export class MessageSender {
  /**
   * Per-chat member-name cache (open_id → display name). Resolved from the chat
   * member list — which uses the `im` scope the bot already has as a member, so
   * NO separate contact scope is required. Cached because names rarely change and
   * we resolve one per inbound group message.
   */
  private memberNameCache = new Map<string, { names: Map<string, string>; ts: number }>();

  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /**
   * Resolve a group member's display name from their open_id via the chat member
   * list (cached per chat). Returns undefined when the chat can't be read or the
   * member isn't found — callers fall back to a short id. Never throws.
   */
  async getUserName(chatId: string, openId: string): Promise<string | undefined> {
    const cached = this.memberNameCache.get(chatId);
    if (cached && Date.now() - cached.ts < MEMBER_NAME_TTL_MS) {
      return cached.names.get(openId);
    }
    try {
      const names = new Map<string, string>();
      // SDK types vary across versions; access defensively so a missing method
      // just degrades to "no name" rather than breaking the message path.
      const api = this.client.im.v1 as any;
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const resp: any = await api.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        });
        for (const item of resp?.data?.items ?? []) {
          if (item?.member_id && item?.name) names.set(item.member_id, item.name);
        }
        pageToken = resp?.data?.page_token;
        if (!resp?.data?.has_more || !pageToken) break;
      }
      this.memberNameCache.set(chatId, { names, ts: Date.now() });
      return names.get(openId);
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to resolve chat member names');
      // Negative-cache an empty map so a missing scope / API doesn't spam retries.
      this.memberNameCache.set(chatId, { names: new Map(), ts: Date.now() });
      return undefined;
    }
  }

  async sendCard(chatId: string, cardContent: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: cardContent,
          msg_type: 'interactive',
        },
      });

      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp }, 'Failed to get message_id from send response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send card');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardContent: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardContent },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update card');
      return false;
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, imageKey, savePath }, 'Image downloaded');
        return true;
      }
      this.logger.error({ messageId, imageKey }, 'Empty response when downloading image');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, imageKey }, 'Failed to download image');
      return false;
    }
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, fileKey, savePath }, 'File downloaded');
        return true;
      }
      this.logger.error({ messageId, fileKey }, 'Empty response when downloading file');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, fileKey }, 'Failed to download file');
      return false;
    }
  }

  async uploadImage(filePath: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      const imageKey = resp?.image_key;
      if (imageKey) {
        this.logger.info({ filePath, imageKey }, 'Image uploaded to Feishu');
      }
      return imageKey;
    } catch (err) {
      this.logger.error({ err, filePath }, 'Failed to upload image');
      return undefined;
    }
  }

  async sendImage(chatId: string, imageKey: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, imageKey }, 'Failed to send image');
      return false;
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    const imageKey = await this.uploadImage(filePath);
    if (!imageKey) return false;
    return this.sendImage(chatId, imageKey);
  }

  async uploadFile(filePath: string, fileName: string, fileType: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.file.create({
        data: {
          file_type: fileType as any,
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      const fileKey = resp?.file_key;
      if (fileKey) {
        this.logger.info({ filePath, fileKey, fileType }, 'File uploaded to Feishu');
      }
      return fileKey;
    } catch (err) {
      this.logger.error({ err, filePath, fileType }, 'Failed to upload file');
      return undefined;
    }
  }

  async sendFile(chatId: string, fileKey: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'file',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send file');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string, fileType: string): Promise<boolean> {
    const fileKey = await this.uploadFile(filePath, fileName, fileType);
    if (!fileKey) return false;
    return this.sendFile(chatId, fileKey);
  }

  async getChatMemberCount(chatId: string): Promise<number | undefined> {
    try {
      const resp: any = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const userCount = parseInt(resp?.data?.user_count, 10) || 0;
      const botCount = parseInt(resp?.data?.bot_count, 10) || 0;
      return userCount + botCount;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to get chat member count');
      return undefined;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send text');
    }
  }
}
