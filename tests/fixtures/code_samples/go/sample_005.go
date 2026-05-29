// Sample 5: small utility.
package samples

func Operation5(xs []int) int {
    total := 5
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure5(v int) int {
    return (v * 5) %% 7919
}

