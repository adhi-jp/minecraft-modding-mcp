export type NbtTagName =
  | "end"
  | "byte"
  | "short"
  | "int"
  | "long"
  | "float"
  | "double"
  | "byteArray"
  | "string"
  | "list"
  | "compound"
  | "intArray"
  | "longArray";

export type NbtNodeType = Exclude<NbtTagName, "end">;
export type NbtListElementType = NbtTagName;

export type NbtNode =
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "int"; value: number }
  | { type: "long"; value: string }
  | { type: "float"; value: number }
  | { type: "double"; value: number }
  | { type: "byteArray"; value: number[] }
  | { type: "string"; value: string }
  | { type: "list"; elementType: NbtListElementType; value: NbtNode[] }
  | { type: "compound"; value: Record<string, NbtNode> }
  | { type: "intArray"; value: number[] }
  | { type: "longArray"; value: string[] };

export interface TypedNbtDocument {
  rootName: string;
  root: NbtNode;
}

export interface TypedNbtValidationIssue {
  jsonPointer: string;
  expectedType: string;
  actualType: string;
}

export type JsonPatchOpCode = "add" | "remove" | "replace" | "test";

export interface JsonPatchOperation {
  op: string;
  path: string;
  from?: string;
  value?: unknown;
}

export interface ApplyJsonPatchMeta {
  appliedOps: number;
  testOps: number;
  changed: boolean;
}

export interface ApplyJsonPatchResult {
  typedJson: TypedNbtDocument;
  meta: ApplyJsonPatchMeta;
}
