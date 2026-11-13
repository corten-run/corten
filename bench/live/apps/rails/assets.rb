require "bundler/setup"
require "fileutils"

# Serve installed libraries as normal Rails public assets, not protected controller actions.
destination = File.join(__dir__, "public", "native")
FileUtils.mkdir_p(destination)
{
  "turbo.js" => ["turbo-rails", "app/assets/javascripts/turbo.js"],
  "cable.js" => ["actioncable", "app/assets/javascripts/actioncable.esm.js"]
}.each do |name, (gem, source)|
  FileUtils.cp(File.join(Gem::Specification.find_by_name(gem).full_gem_path, source), File.join(destination, name))
end
FileUtils.cp(File.join(__dir__, "client.js"), File.join(destination, "client.js"))
