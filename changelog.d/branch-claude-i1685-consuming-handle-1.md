- Inside the framework, the stages around a route reach the request through a handle each
  passes on by value, so a stage that reads the request after its route took it does not
  compile. No release had such a read, and nothing an app sees changes.
