# Chat/Bot 调用统一验收（当前增量）

日期：2026-11-06

本次增量围绕 `chat profile` 上下文收敛（P3 子项）完成以下验收：

- Chat 运行提示不再将 `contextCourseIds` 预注入到用户消息正文。
- `contextCourseIds` 仅作为课程检索过滤条件生效：
  - `list_courses` 只返回会话上下文范围内课程；
  - `search_course_library` 默认按会话上下文过滤，并对越界 `courseId` 返回范围内未命中；
  - `read /courses/<id>/*` 与 `get_course_details` 对会话范围外课程拒绝访问。
- 新增执行器回归覆盖：
  - 验证 chat 请求体不含 `courses` 预注入字段；
  - 验证 `search_course_library` 工具结果遵守 `contextCourseIds` 过滤。

执行验证（定向）：

- `node scripts/test-task-executors.mjs`
