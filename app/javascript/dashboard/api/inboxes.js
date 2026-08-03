/* global axios */
import CacheEnabledApiClient from './CacheEnabledApiClient';

class Inboxes extends CacheEnabledApiClient {
  constructor() {
    super('inboxes', { accountScoped: true });
  }

  // eslint-disable-next-line class-methods-use-this
  get cacheModelName() {
    return 'inbox';
  }

  getCampaigns(inboxId) {
    return axios.get(`${this.url}/${inboxId}/campaigns`);
  }

  deleteInboxAvatar(inboxId) {
    return axios.delete(`${this.url}/${inboxId}/avatar`);
  }

  getAgentBot(inboxId) {
    return axios.get(`${this.url}/${inboxId}/agent_bot`);
  }

  setAgentBot(inboxId, botId) {
    return axios.post(`${this.url}/${inboxId}/set_agent_bot`, {
      agent_bot: botId,
    });
  }

  syncTemplates(inboxId) {
    return axios.post(`${this.url}/${inboxId}/sync_templates`);
  }

  updateWhatsappBusinessManagementToken(inboxId, businessManagementToken) {
    return axios.put(
      `${this.url}/${inboxId}/whatsapp_business_management_token`,
      {
        business_management_token: businessManagementToken,
      }
    );
  }

  createCSATTemplate(inboxId, template) {
    return axios.post(`${this.url}/${inboxId}/csat_template`, {
      template,
    });
  }

  getCSATTemplateStatus(inboxId) {
    return axios.get(`${this.url}/${inboxId}/csat_template`);
  }

  analyzeCSATTemplateUtility(inboxId, template) {
    return axios.post(`${this.url}/${inboxId}/csat_template/analyze`, {
      template,
    });
  }

  resetSecret(inboxId) {
    return axios.post(`${this.url}/${inboxId}/reset_secret`);
  }

  enableWhatsappCalling(inboxId) {
    return axios.post(`${this.url}/${inboxId}/enable_whatsapp_calling`);
  }

  disableWhatsappCalling(inboxId) {
    return axios.post(`${this.url}/${inboxId}/disable_whatsapp_calling`);
  }

  setInboundCalls(inboxId, enabled) {
    return axios.post(`${this.url}/${inboxId}/set_inbound_calls`, {
      inbound_calls_enabled: enabled,
    });
  }

  // ---- Zalo Personal channel (phase 05) -----------------------------------
  // Note: these routes live under `namespace :channels` directly on the
  // account (see config/routes.rb), NOT under the inboxes scope — so we
  // build the URL from baseUrl() (which already includes the account
  // prefix because this client is accountScoped) and bypass `this.url`
  // (which would resolve to .../inboxes/... due to the Inboxes resource).

  zaloBaseUrl() {
    return `${this.baseUrl()}/channels/zalo`;
  }

  startZaloLogin(options = {}) {
    return axios.post(`${this.zaloBaseUrl()}/login`, options);
  }

  getZaloLoginStatus(sessionId) {
    return axios.get(`${this.zaloBaseUrl()}/login/${sessionId}`);
  }

  reloginZaloChannel(channelId) {
    return axios.post(`${this.zaloBaseUrl()}/${channelId}/relogin`);
  }

  deleteZaloSession(sessionId) {
    return axios.delete(`${this.zaloBaseUrl()}/${sessionId}`);
  }
}

export default new Inboxes();
