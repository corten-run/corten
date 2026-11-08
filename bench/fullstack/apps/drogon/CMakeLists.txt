cmake_minimum_required(VERSION 3.20)
project(item_page_drogon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Drogon CONFIG REQUIRED)
find_package(ICU 72 REQUIRED COMPONENTS i18n uc)

add_executable(server src/main.cc src/model.cc src/items.cc src/live.cc src/catalog.cc src/marketplace.cc src/marketplace_model.cc)
target_include_directories(server PRIVATE src)
target_link_libraries(server PRIVATE Drogon::Drogon ICU::i18n ICU::uc)
# The .csp views compile to C++ classes (drogon_ctl create view) when the server builds.
drogon_create_views(server ${CMAKE_CURRENT_SOURCE_DIR}/views ${CMAKE_CURRENT_BINARY_DIR}/views)
target_include_directories(server PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/views)

option(BUILD_TESTING "Build the focused marketplace tests" OFF)
include(CTest)
if(BUILD_TESTING)
  add_executable(marketplace_test tests/marketplace_test.cc src/marketplace_model.cc)
  target_include_directories(marketplace_test PRIVATE src)
  target_link_libraries(marketplace_test PRIVATE Drogon::Drogon ICU::i18n ICU::uc)
  target_compile_options(marketplace_test PRIVATE -UNDEBUG)
  add_test(NAME marketplace COMMAND marketplace_test)
  set_tests_properties(marketplace PROPERTIES WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
endif()
