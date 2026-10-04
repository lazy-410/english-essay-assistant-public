// JNI 包装：把 Java 传来的 argv 交给 node::Start 启动嵌入式 Node。
// 模式取自 nodejs-mobile 官方样例（node::Start + libuv 参数内存连续要求）。
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include "node.h"

// 启动 Node 事件循环：本函数在 Node 退出前不返回，必须在独立 Java 线程调用。
extern "C" JNIEXPORT jint JNICALL
Java_cn_kaoyan_essay_runtime_NodeRuntime_startNodeWithArguments(
    JNIEnv *env, jobject /* this */, jobjectArray arguments) {

  jsize argument_count = env->GetArrayLength(arguments);

  int c_arguments_size = 0;
  for (int i = 0; i < argument_count; i++) {
    c_arguments_size += strlen(env->GetStringUTFChars(
        (jstring)env->GetObjectArrayElement(arguments, i), 0));
    c_arguments_size++;  // '\0'
  }

  char *args_buffer = (char *)calloc(c_arguments_size, sizeof(char));
  char *argv[argument_count];
  char *current = args_buffer;
  for (int i = 0; i < argument_count; i++) {
    const char *arg = env->GetStringUTFChars(
        (jstring)env->GetObjectArrayElement(arguments, i), 0);
    strncpy(current, arg, strlen(arg));
    argv[i] = current;
    current += strlen(current) + 1;
    env->ReleaseStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), arg);
  }

  int node_result = node::Start(argument_count, argv);
  free(args_buffer);
  return (jint)node_result;
}

// 在 node::Start 之前设置进程环境变量（必须早于 Node 读取 process.env）。
extern "C" JNIEXPORT void JNICALL
Java_cn_kaoyan_essay_runtime_NodeRuntime_nativeSetEnv(
    JNIEnv *env, jobject /* this */, jstring key, jstring value) {
  const char *k = env->GetStringUTFChars(key, 0);
  const char *v = value ? env->GetStringUTFChars(value, 0) : nullptr;
  setenv(k, v ? v : "", 1);
  if (v) env->ReleaseStringUTFChars(value, v);
  env->ReleaseStringUTFChars(key, k);
}
