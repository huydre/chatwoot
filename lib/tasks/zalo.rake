namespace :zalo do
  desc 'Subscribe to Redis events from the zalo_service Node sidecar'
  task subscribe: :environment do
    require Rails.root.join('lib/workers/zalo_event_subscriber')
    ZaloEventSubscriber.start
  end
end
