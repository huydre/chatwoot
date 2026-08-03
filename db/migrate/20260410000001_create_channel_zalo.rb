class CreateChannelZalo < ActiveRecord::Migration[7.1]
  def change
    create_table :channel_zalo do |t|
      t.integer :account_id, null: false
      t.string :zalo_own_id
      t.string :display_name
      t.string :phone_number, limit: 32
      t.string :avatar_url
      # Per-channel outbound rate limit override. null means "use env default".
      t.integer :rate_limit_per_minute
      t.timestamps
    end

    add_index :channel_zalo, :zalo_own_id, unique: true, where: 'zalo_own_id IS NOT NULL'
    add_index :channel_zalo, :account_id
  end
end
