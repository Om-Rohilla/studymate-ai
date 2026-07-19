from fastapi import APIRouter, HTTPException
from models.schemas import PlannerRequest, PlannerResponse
from services.llm_service import LLMService

router = APIRouter()

@router.post("/planner", response_model=PlannerResponse)
@router.post("/generate-plan", response_model=PlannerResponse)
async def generate_plan(req: PlannerRequest):
    if not req.subjects.strip():
        raise HTTPException(status_code=400, detail="Subjects list cannot be empty.")
    if not req.date.strip():
        raise HTTPException(status_code=400, detail="Target exam date cannot be empty.")
        
    plan_data = LLMService.generate_planner(
        subjects=req.subjects,
        date=req.date,
        hours=req.hours,
        strategy=req.strategy
    )
    
    if "plan" not in plan_data:
        raise HTTPException(status_code=500, detail="LLM failed to return structured planner format.")
        
    return PlannerResponse(status="success", plan=plan_data["plan"])
