const { EmbedBuilder, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');

class ServerStatus {
  constructor(config) {
    this.config = config;
    this.name = "ServerStatus Plugin";
    this.interval = null;
    this.isInitialized = false;
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
  }

  async prepareToMount(serverInstance, discordClient) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      if (!pluginConfig?.enabled || !pluginConfig?.channel) {
        return;
      }

      this.channelId = pluginConfig.channel;
      const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, { cache: true, force: true });
      this.channel = await guild.channels.fetch(this.channelId);

      if (!this.channel?.isTextBased()) {
        return;
      }

      const permissions = this.channel.permissionsFor(this.discordClient.user);
      if (!permissions?.has(["ViewChannel", "SendMessages", "EmbedLinks"])) {
        return;
      }

      if (pluginConfig.messageID) {
        try {
          this.message = await this.channel.messages.fetch(pluginConfig.messageID);
        } catch {
          this.message = await this.postInitialEmbed();
        }
      } else {
        this.message = await this.postInitialEmbed();
      }

      this.interval = setInterval(() => this.updateEmbed(), (pluginConfig.interval || 1) * 60 * 1000);
      this.isInitialized = true;
    } catch (error) {
      console.error("[ServerStatus] Error during prepareToMount:", error);
    }
  }

  async postInitialEmbed() {
    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      const serverName = this.config.server?.name || "Unknown";

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        .setDescription(serverName)
        .setTimestamp()
        .addFields(
          { name: "Player Count", value: "Loading...", inline: true },
          { name: "FPS", value: "Loading...", inline: true },
          { name: "Memory Usage", value: "Loading...", inline: true }
        );

      if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
      if (embedConfig.thumbnailURL?.trim()) embed.setThumbnail(embedConfig.thumbnailURL);

      const message = await this.channel.send({ embeds: [embed] });
      pluginConfig.messageID = message.id;
      await this.saveConfig();

      return message;
    } catch (error) {
      throw error;
    }
  }

  async saveConfig() {
    try {
      const configPath = path.resolve(__dirname, "../../config.json");
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), "utf8");
    } catch (error) {}
  }

  async updateEmbed() {
    try {
      const pluginConfig = this.config.plugins.find(p => p.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      const serverName = this.config.server?.name || "Unknown";
  
      const playerCount = global.serverPlayerCount || 0;
      const fps = global.serverFPS || 0;
      const memoryUsageMB = ((global.serverMemoryUsage || 0) / 1024).toFixed(2);
  
      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        .setDescription(serverName)
        .setTimestamp()
        .addFields(
          { name: "Player Count", value: `${playerCount}`, inline: true },
          { name: "FPS", value: `${fps}`, inline: true },
          { name: "Memory Usage", value: `${memoryUsageMB} MB`, inline: true }
        );
  
      if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
      if (embedConfig.thumbnailURL?.trim()) embed.setThumbnail(embedConfig.thumbnailURL);
  
      if (!this.message) {
        console.warn("[ServerStatus] No message found, reposting embed...");
        this.message = await this.postInitialEmbed();
      }
  
      if (this.message?.editable) {
        await this.message.edit({ embeds: [embed] });
      } else {
        console.warn("[ServerStatus] Message is not editable.");
      }
  
      if (pluginConfig.discordBotStatus && this.discordClient?.user) {
        this.discordClient.user.setActivity(
          `📢${playerCount} Players | ${fps} FPS`,
          { type: ActivityType.Watching }
        );
      }
  
    } catch (error) {
      console.error("[ServerStatus] Failed to update embed or activity:", error);
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
  }
}

module.exports = ServerStatus;
