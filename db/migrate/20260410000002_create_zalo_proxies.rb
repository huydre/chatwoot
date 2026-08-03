class CreateZaloProxies < ActiveRecord::Migration[7.1]
  def change
    create_table :zalo_proxies do |t|
      t.integer :account_id, null: false
      t.string :name, null: false
      t.string :scheme, null: false, limit: 16   # http | https | socks5
      t.string :host, null: false
      t.integer :port, null: false
      t.string :username
      # Encrypted via Active Record Encryption in the model. TEXT column since
      # AR Encryption output is longer than the plaintext.
      t.text :password
      t.string :status, default: 'active', null: false
      t.datetime :last_checked_at
      t.jsonb :metadata, default: {}, null: false
      t.timestamps
    end

    add_index :zalo_proxies, :account_id
    add_index :zalo_proxies, :status
  end
end
