/* eslint-disable */
// Migration 006 — liga a regra "Cálculo da margem de lucro por motoboy (COMOLLATI BRASILIA)" ao
// cálculo pronto margem_por_motoboy: cliente 767, só os centros BR Auto Parts Brasília e Comollati Brasília,
// R$ 250 recebidos e R$ 80 de moto por motoboy no dia (cada motoboy conta uma vez por dia).
// Só mexe no registro vigente com esse assunto e só se ele ainda não tiver um cálculo ligado.
export default String.raw`
UPDATE cerebro.registros
   SET dados = COALESCE(dados, '{}'::jsonb) || jsonb_build_object('calculo', jsonb_build_object(
         'nome', 'margem_por_motoboy',
         'parametros', jsonb_build_object(
           'cod_cliente', 767,
           'centros', jsonb_build_array('br auto brasilia', 'comollati brasilia'),
           'receita_dia', 250,
           'custo_dia', 80)))
 WHERE status = 'vigente'
   AND titulo ILIKE '%margem%motoboy%'
   AND titulo ILIKE '%comollati%'
   AND NOT (COALESCE(dados, '{}'::jsonb) ? 'calculo');
`;
