from pydantic import BaseModel


class ColumnSchema(BaseModel):
    name: str
    data_type: str


class TableSchema(BaseModel):
    name: str
    columns: list[ColumnSchema]


class DataSourceSchemaResponse(BaseModel):
    tables: list[TableSchema]
