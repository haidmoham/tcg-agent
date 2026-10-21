// Existing learned actors + visible history + rules validation, in one seam.
// This module never owns a worker, hidden board, client input, or training loop.
export class AgentBundle {
  constructor({ordinary,selection,catalog,encode,supportsCardSelection,rankedPromptAnswers,helper=null,pins,historyMode='observed-only',deterministic=true}) {
    if(!['observed-only','complete-game'].includes(historyMode))throw Error('explicit supported public-history mode required');
    if(typeof deterministic!=='boolean')throw Error('explicit sampling mode required');
    this.historyMode=historyMode;
    this.deterministic=deterministic;
    Object.assign(this,{ordinary,selection,catalog,encode,supportsCardSelection,rankedPromptAnswers,helper});
    this.pins=Object.freeze({...pins,historyMode,deterministic});this.turn=null;this.lastRevision=null;this.originAction=null;this.originCard=null;
    this.usage={};this.entityUsage={};
  }

  observe(view) {
    // Call at every actor-visible revision, including out-of-turn frames.
    if(view.opponent?.hand!=null||view.opponent?.deck!=null)throw Error('actor-visible projection required');
    if(this.historyMode==='complete-game'){
      if(this.lastRevision===null&&(view.revision!==0||view.turnNumber!==0))throw Error('complete history must start at game creation');
      if(this.lastRevision!==null&&(view.revision<this.lastRevision||view.revision>this.lastRevision+1))throw Error('complete history lost a visible revision');
    }
    this.lastRevision=view.revision;
    if(this.turn!==view.turnNumber){
      this.turn=view.turnNumber;this.originAction=null;this.originCard=null;this.entityUsage={};
      this.usage=Object.fromEntries(['energyPlayed','supporterPlayed','retreated'].map(k=>[k,
        {known:this.historyMode==='complete-game',value:this.historyMode==='complete-game'?false:null}]));
    }
    for(const card of [view.you.active,...view.you.bench].filter(Boolean))
      this.entityUsage[card.instanceId]??={abilityUsed:
        {known:this.historyMode==='complete-game',value:this.historyMode==='complete-game'?false:null}};
    return {...view,decisionContext:{originAction:this.originAction,originCard:this.originCard,
      usage:structuredClone(this.usage),entityUsage:structuredClone(this.entityUsage)}};
  }

  route(view) {
    if(['finished','failed'].includes(view.status))return 'terminal';
    if(view.status!=='playing')return view.status==='setup'?'helper':'waiting';
    const prompt=view.prompts[0];
    if(!prompt)return view.turn==='you'&&view.actions.length?'ordinary':'waiting';
    if(!this.supportsCardSelection(view))return 'helper';
    return prompt.min===1&&prompt.max===1&&!prompt.ordered
      &&prompt.choices.every(c=>c.minAmount==null&&c.maxAmount==null&&c.initialAmount==null)
      ?'singleton':'ranking';
  }

  async propose(view,{validate}={}) {
    const route=this.route(view);
    if(route==='ordinary'){
      if(typeof this.ordinary.act!=='function'){
        if(!this.deterministic)throw Error('categorical collection needs an actor with log probabilities and values');
        return {source:'ordinary',decisions:[await this.ordinary.decide({view})]};
      }
      const encoded=this.encode(view,{catalog:this.catalog});
      const [sample]=await this.ordinary.act([encoded],{deterministic:this.deterministic});
      if(!view.actions[sample.actionIndex])throw Error('actor chose outside the offered ordinary actions');
      return {source:'ordinary',decisions:[{actionId:view.actions[sample.actionIndex].id}],sample,encoded};
    }
    if(route==='ranking')return {source:'selection',decisions:this.rankedPromptAnswers(view,await this.selection.rankChoices({view}))};
    if(route!=='singleton')return {source:route,decisions:route==='helper'&&this.helper?this.helper(view):null};
    if(typeof validate!=='function')throw Error('current environment singleton validator required');
    const prompt=view.prompts[0],encoded=this.encode(view,{catalog:this.catalog});
    encoded.selectionCardinality=1;encoded.legalMask=[];
    for(const choice of prompt.choices)encoded.legalMask.push(await validate({promptId:prompt.id,choiceIds:[choice.id]})===true);
    if(!encoded.legalMask.some(Boolean))throw Error('no native-valid current singleton choice');
    const [sample]=await this.ordinary.act([encoded],{deterministic:this.deterministic});
    if(!encoded.legalMask[sample.actionIndex])throw Error('actor chose outside validated singleton mask');
    return {source:'singleton',decisions:[{promptId:prompt.id,choiceIds:[prompt.choices[sample.actionIndex].id]}],sample,encoded};
  }

  accepted(view,decision) {
    // Call only after the environment's authoritative acceptance receipt.
    if(!decision.actionId)return;
    const action=view.actions.find(a=>a.id===decision.actionId);
    if(!action)throw Error('accepted action is not in the observed offer');
    this.originAction=action;
    this.originCard=[view.you.active,...view.you.bench,...view.hand,...view.you.discard]
      .find(c=>c?.instanceId===(action.sourceCardId??action.actorId))??null;
    if(action.kind==='retreat')this.usage.retreated={known:true,value:true};
    if(action.kind==='ability'&&action.actorId)this.entityUsage[action.actorId]={abilityUsed:{known:true,value:true}};
    if(action.kind==='play'&&this.originCard?.category==='energy')this.usage.energyPlayed={known:true,value:true};
    const token=this.catalog.printingAliases?.[this.originCard?.printingId]??this.originCard?.printingId;
    if(action.kind==='play'&&this.catalog.cards[this.catalog.cardIds[token]??0]?.format==='supporter')
      this.usage.supporterPlayed={known:true,value:true};
  }
}
