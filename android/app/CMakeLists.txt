cmake_minimum_required(VERSION 3.18.1)

project("kaoyan-essay-native")

# 本机 JNI 包装：接收 argv 并调用 node::Start 启动嵌入式 Node
add_library(native-lib SHARED src/main/cpp/native-lib.cpp)

# Node.js 头文件
include_directories(libnode/include/node/)

# 预编译的 libnode（nodejs-mobile 官方构建）
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(native-lib libnode ${log-lib})
