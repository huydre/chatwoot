# Extracts typed fields from the raw Zalo message payload that arrives via
# Redis pub/sub. Keeps the IncomingMessageService clean and makes it easy to
# adapt to zca-js payload shape changes in one place.
module Zalo::ParamHelpers
  private

  def zalo_msg_id
    payload['msgId'] || payload.dig('data', 'msgId') || payload.dig('data', 'cliMsgId')
  end

  def zalo_thread_id
    payload['threadId'] || payload['thread_id']
  end

  # zca-js ThreadType: User=0, Group=1
  def zalo_thread_type
    (payload['type'] || payload['threadType'] || 0).to_i
  end

  def group_message?
    zalo_thread_type == 1
  end

  def zalo_from_id
    payload.dig('data', 'uidFrom') || payload['uidFrom'] || payload['from']
  end

  # True when the account itself is the author — either typed in the Zalo app
  # or echoed back after Chatwoot sent it. zca-js only emits these because the
  # client is created with `selfListen: true`.
  def self_message?
    payload['isSelf'] == true || payload.dig('data', 'isSelf') == true
  end

  def zalo_from_name
    payload.dig('data', 'dName') || payload['dName'] || "Zalo User #{zalo_from_id.to_s.last(6)}"
  end

  def zalo_content
    raw = payload.dig('data', 'content')
    return raw if raw.is_a?(String)
    # Multi-media or structured content arrives as a hash — fall back to a
    # placeholder so the UI still renders something.
    return raw['title'] if raw.is_a?(Hash) && raw['title'].present?

    '[attachment]'
  end

  def zalo_timestamp
    ts = payload.dig('data', 'ts') || payload['ts']
    ts ? Time.zone.at(ts.to_i / 1000) : Time.current
  end

  def zalo_attachments
    raw = payload.dig('data', 'content')
    return [] unless raw.is_a?(Hash)

    # zca-js wraps media in the content hash with keys like href, thumb,
    # photoUrl, ... We extract the primary URL and let the Rails downloader
    # fetch it async.
    url = raw['href'] || raw['photoUrl'] || raw['hdUrl'] || raw['url']
    return [] if url.blank?

    [{ 'url' => url, 'type' => infer_file_type(raw), 'filename' => raw['fileName'] }]
  end

  def infer_file_type(content)
    return :image if content['photoUrl'] || content['thumb'] || content['hdUrl']
    return :video if content['href']&.match?(/\.(mp4|mov|webm)/i)
    return :audio if content['href']&.match?(/\.(mp3|m4a|ogg|wav)/i)

    :file
  end
end
