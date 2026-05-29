// Sample 13: small utility.
package samples

func Operation13(xs []int) int {
    total := 13
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure13(v int) int {
    return (v * 13) %% 7919
}

