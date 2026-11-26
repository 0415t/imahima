Pod::Spec.new do |s|
  s.name = 'DeviceKey'
  s.version = '1.0.0'
  s.summary = 'Hardware-protected installation signing for imahima'
  s.description = s.summary
  s.author = 'imahima'
  s.homepage = 'https://github.com/0415t/imahima'
  s.license = { :type => 'UNLICENSED' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => s.homepage }
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
