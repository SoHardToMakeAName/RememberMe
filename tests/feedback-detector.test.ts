// tests/feedback-detector.test.ts
// v0.16.0: 反馈检测器单元测试
//
// 覆盖 parseFeedbackResult 的解析容错

import { describe, it, expect } from "bun:test";
import { parseFeedbackResult } from "../src/feedback-detector.ts";

describe("parseFeedbackResult", () => {
  it("标准 JSON 直接解析", () => {
    const r = parseFeedbackResult(`{"signal":"positive","insights":["用户喜欢具体例子","用户希望先答后讲"],"reason":"用户深入讨论","example":{"userMessage":"x","aiReply":"y","whyWorked":"好"}}`);
    expect(r.signal).toBe("positive");
    expect(r.insights).toEqual(["用户喜欢具体例子", "用户希望先答后讲"]);
    expect(r.example?.userMessage).toBe("x");
    expect(r.example?.whyWorked).toBe("好");
    expect(r.reason).toBe("用户深入讨论");
  });

  it("包在 markdown code fence 里也能解析", () => {
    const r = parseFeedbackResult("```json\n{\"signal\":\"negative\",\"insights\":[\"用户嫌深\"],\"reason\":\"用户嫌深\"}\n```");
    expect(r.signal).toBe("negative");
    expect(r.insights).toContain("用户嫌深");
    expect(r.reason).toBe("用户嫌深");
  });

  it("非法 JSON 返回 neutral", () => {
    const r = parseFeedbackResult("this is not json");
    expect(r.signal).toBe("neutral");
    expect(r.insights).toEqual([]);
    expect(r.reason).toContain("无 JSON");
  });

  it("空字符串返回 neutral", () => {
    const r = parseFeedbackResult("");
    expect(r.signal).toBe("neutral");
  });

  it("signal 字段非法值降级为 neutral", () => {
    const r = parseFeedbackResult('{"signal":"unknown_thing"}');
    expect(r.signal).toBe("neutral");
  });

  it("insights 字段非数组则为空", () => {
    const r = parseFeedbackResult('{"signal":"positive","insights":"not an array"}');
    expect(r.insights).toEqual([]);
  });

  it("insights 数组里的非字符串被过滤", () => {
    const r = parseFeedbackResult('{"signal":"positive","insights":["好的", 123, "坏的", null, "中间的"]}');
    expect(r.insights).toEqual(["好的", "坏的", "中间的"]);
  });

  it("example 对象为空字符串被丢弃", () => {
    const r = parseFeedbackResult('{"signal":"positive","example":{"userMessage":"","aiReply":""}}');
    expect(r.example).toBeUndefined();
  });

  it("example 同时包含 whyWorked 和 whyDidntWork 时保留两者", () => {
    const r = parseFeedbackResult('{"signal":"positive","example":{"userMessage":"q","aiReply":"a","whyWorked":"worked","whyDidntWork":"didnt"}}');
    expect(r.example?.whyWorked).toBe("worked");
    expect(r.example?.whyDidntWork).toBe("didnt");
  });

  it("reason 超过 100 字会被截断", () => {
    const long = "x".repeat(200);
    const r = parseFeedbackResult(`{"signal":"neutral","insights":[],"reason":"${long}"}`);
    expect(r.reason.length).toBe(100);
  });

  it("insight 单条超过 200 字会被截断", () => {
    const long = "x".repeat(300);
    const r = parseFeedbackResult(`{"signal":"positive","insights":["${long}"]}`);
    expect(r.insights[0].length).toBe(200);
  });

  it("从文本中提取 JSON 块（带额外文字）", () => {
    const r = parseFeedbackResult(`这是我的分析：{"signal":"positive","insights":["OK"],"reason":"好"}就这样`);
    expect(r.signal).toBe("positive");
    expect(r.insights).toContain("OK");
  });
});