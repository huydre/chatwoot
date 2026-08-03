class CreateZaloSessions < ActiveRecord::Migration[7.1]
  def change
    create_table :zalo_sessions do |t|
      t.bigint :channel_zalo_id, null: false
      t.bigint :zalo_proxy_id
      t.string :session_id, null: false
      # Cookies + imei are encrypted via Active Record Encryption in the model.
      t.text :cookies
      t.text :imei
      t.string :user_agent, limit: 512
      t.string :status, null: false, default: 'pending'
      t.datetime :last_connected_at
      t.datetime :last_seen_at
      t.jsonb :metadata, default: {}, null: false
      t.timestamps
    end

    add_index :zalo_sessions, :session_id, unique: true
    add_index :zalo_sessions, :channel_zalo_id
    add_index :zalo_sessions, :zalo_proxy_id
    add_index :zalo_sessions, :status

    add_foreign_key :zalo_sessions, :channel_zalo, column: :channel_zalo_id, on_delete: :cascade
    add_foreign_key :zalo_sessions, :zalo_proxies, column: :zalo_proxy_id, on_delete: :nullify
  end
end
