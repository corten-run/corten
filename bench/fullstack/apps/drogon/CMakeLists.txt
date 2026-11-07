cmake_minimum_required(VERSION 3.20)
project(item_page_drogon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Drogon CONFIG REQUIRED)

add_executable(server src/main.cc src/model.cc src/items.cc src/live.cc src/catalog.cc)
target_include_directories(server PRIVATE src)
target_link_libraries(server PRIVATE Drogon::Drogon)
# The .csp views compile to C++ classes (drogon_ctl create view) when the server builds.
drogon_create_views(server ${CMAKE_CURRENT_SOURCE_DIR}/views ${CMAKE_CURRENT_BINARY_DIR}/views)
target_include_directories(server PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/views)
